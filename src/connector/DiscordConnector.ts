"use strict";

import { EventEmitter } from "events";
import BetterWs = require("../structures/BetterWs");
import { GATEWAY_OP_CODES as OP, GATEWAY_VERSION } from "../Constants";
import Intents = require("../Intents");

import type {
	GatewayReceivePayload,
	GatewayIdentify,
	GatewayPresenceUpdateData,
	GatewayVoiceStateUpdateData,
	GatewayRequestGuildMembersData,
	GatewayRequestGuildMembersDataWithQuery,
	GatewayRequestGuildMembersDataWithUserIds
} from "discord-api-types/v10";

import { PresenceUpdateStatus } from "discord-api-types/v10";

interface ConnectorEvents {
	queueIdentify: [number];
	ready: [boolean];
	disconnect: [number, string, boolean];
	stateChange: ["connecting" | "identifying" | "resuming" | "ready" | "disconnected"]
}

interface DiscordConnector {
	addListener<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any): this;
	emit<E extends keyof ConnectorEvents>(event: E, ...args: ConnectorEvents[E]): boolean;
	eventNames(): Array<keyof ConnectorEvents>;
	listenerCount(event: keyof ConnectorEvents): number;
	listeners(event: keyof ConnectorEvents): Array<(...args: Array<any>) => any>;
	off<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any): this;
	on<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any): this;
	once<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any): this;
	prependListener<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any): this;
	prependOnceListener<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any): this;
	rawListeners(event: keyof ConnectorEvents): Array<(...args: Array<any>) => any>;
	removeAllListeners(event?: keyof ConnectorEvents): this;
	removeListener<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any): this;
}

const recoverableErrorsRegex = /(?:EAI_AGAIN)|(?:ECONNRESET)/;

/**
 * Class used for acting based on received events.
 *
 * This class is automatically instantiated by the library and is documented for reference.
 */
class DiscordConnector extends EventEmitter {
	public options: DiscordConnector["client"]["options"];
	public reconnect: boolean;
	public betterWs: BetterWs;
	public heartbeatTimeout: NodeJS.Timeout | null = null;
	public heartbeatInterval = 0;
	public _trace: string | null = null;
	public seq = 0;
	public status: "connecting" | "identifying" | "resuming" | "ready" | "disconnected" = "disconnected";
	public sessionId: string | null = null;
	public lastACKAt = 0;
	public lastHeartbeatSend = 0;
	public latency = 0;
	private _closing = false;
	public identifyAddress: string;
	public resumeAddress: string | null = null;
	public reconnecting = false;

	public static readonly default = DiscordConnector;

	/**
	 * Create a new Discord Connector.
	 * @param id id of the shard that created this class.
	 * @param client Main client instance.
	 */
	public constructor(public id: number, public client: EventEmitter & { options: Omit<import("../Types").IClientOptions, "snowtransferInstance"> & { token: string; endpoint?: string; } }) {
		super();

		this.options = client.options;
		this.reconnect = this.options.reconnect ?? true;
		this.identifyAddress = this.options.endpoint!;

		this.betterWs = new BetterWs(this.identifyAddress, this.options.ws!);

		this.betterWs.on("ws_open", () => {
			this.status = "connecting";
			this.emit("stateChange", "connecting");
			this.reconnecting = false;
		});
		this.betterWs.on("ws_receive", msg => this.messageAction(msg));
		this.betterWs.on<"ws_close">("ws_close", (code, reason) => this.handleWsClose(code, reason));
		this.betterWs.on("debug", event => this.client.emit("error", event));
		this.betterWs.on("ws_send", data => this.client.emit("rawSend", data));
	}

	/**
	 * Connect to Discord.
	 */
	public async connect(): Promise<void> {
		this._closing = false;
		this.client.emit("debug", `Shard ${this.id} connecting to gateway`);
		// The address should already be updated if resuming/identifying
		return this.betterWs.connect()
			.catch(error => {
				const e = String(error);
				if (recoverableErrorsRegex.test(e)) {
					setTimeout(() => this.connect(), 5000);
				}
			});
	}

	/**
	 * Close the websocket connection and disconnect.
	 */
	public async disconnect(): Promise<void> {
		this._closing = true;
		return this.betterWs.close(1000, "Disconnected by User");
	}

	/**
	 * Called with a parsed Websocket message to execute further actions.
	 * @param message Message that was received.
	 */
	private async messageAction(message: GatewayReceivePayload): Promise<void> {
		this.client.emit("rawReceive", message);
		const withShardID: import("../Types").IGatewayMessage = Object.assign(message, { shard_id: this.id });
		this.client.emit("event", withShardID);

		switch (withShardID.op) {
		case OP.DISPATCH:
			this.handleDispatch(withShardID);
			break;

		case OP.HEARTBEAT:
			this.heartbeat();
			break;

		case OP.RECONNECT:
			this.client.emit("debug", `Gateway asked shard ${this.id} to reconnect`);
			if (this.options.reconnect) this._reconnect(true);
			else this.disconnect();
			break;

		case OP.INVALID_SESSION:
			this.client.emit("debug", `Shard ${this.id}'s session was invalidated`);
			if (withShardID.d && this.sessionId) this.resume();
			else {
				this.seq = 0;
				this.sessionId = "";
				this.emit("queueIdentify", this.id);
			}
			break;

		case OP.HELLO:
			this.client.emit("debug", `Shard ${this.id} received HELLO`);
			this.heartbeat();
			this.heartbeatInterval = withShardID.d.heartbeat_interval;
			this.setHeartBeat();
			this._trace = (withShardID.d as unknown as { _trace: string })._trace;
			this.emit("queueIdentify", this.id);
			break;

		case OP.HEARTBEAT_ACK:
			this.lastACKAt = Date.now();
			this.latency = this.lastACKAt - this.lastHeartbeatSend;
			break;

		default:
			void 0;
		}
	}

	/**
	 * Reset this connector to be ready to resume or hard reconnect, then connect.
	 * @param resume Whether or not the client intends to send an OP 6 RESUME later.
	 */
	private async _reconnect(resume = false): Promise<void> {
		if (resume) this.reconnecting = true;
		if (this.betterWs.status === 2) return void this.client.emit("error", `Shard ${this.id} was attempting to ${resume ? "resume" : "reconnect"} while the WebSocket was still in the connecting state. This should never happen.`);
		await this.betterWs.close(resume ? 4000 : 1012, "reconnecting");
		if (resume) {
			this.clearHeartBeat();
			if (this.resumeAddress) this.betterWs.address = this.resumeAddress;
			else this.betterWs.address = this.identifyAddress;
		} else {
			this.reset();
			this.betterWs.address = this.identifyAddress;
		}
		this.connect();
	}

	/**
	 * Hard reset this connector.
	 */
	private reset(): void {
		this.sessionId = null;
		this.seq = 0;
		this.lastACKAt = 0;
		this._trace = null;
		this.clearHeartBeat();
	}

	private setHeartBeat(): void {
		this.heartbeatTimeout = setInterval(() => {
			if (this.lastACKAt <= Date.now() - (this.heartbeatInterval + 5000)) {
				this.client.emit("debug", `Shard ${this.id} has not received a heartbeat ACK in ${this.heartbeatInterval + 5000}ms.`);
				if (this.options.reconnect) this._reconnect(true);
				else this.disconnect();
			} else this.heartbeat();
		}, this.heartbeatInterval);
	}

	/**
	 * Clear the heart beat interval, set it to null and set the cached heartbeat_interval as 0.
	 */
	private clearHeartBeat(): void {
		if (this.heartbeatTimeout) clearInterval(this.heartbeatTimeout);
		this.heartbeatTimeout = null;
		this.heartbeatInterval = 0;
	}

	/**
	 * Send an OP 2 IDENTIFY to the gateway or an OP 6 RESUME if forceful identify is falsy.
	 * @param force Whether CloudStorm should send an OP 2 IDENTIFY even if there's a session that could be resumed.
	 */
	public async identify(force?: boolean): Promise<void> {
		if (this.betterWs.status !== 1) void this.client.emit("error", `Shard ${this.id} was attempting to identify when the ws was not open`);
		if (this.sessionId && !force) return this.resume();
		this.client.emit("debug", `Shard ${this.id} is identifying`);

		this.status = "identifying";
		this.emit("stateChange", "identifying");

		const data = {
			op: OP.IDENTIFY,
			d: {
				token: this.options.token,
				properties: {
					os: process.platform,
					browser: "CloudStorm",
					device: "CloudStorm"
				},
				large_threshold: this.options.largeGuildThreshold,
				shard: [this.id, this.options.totalShards ?? 1],
				intents: this.options.intents ? Intents.resolve(this.options.intents) : 0
			}
		} as GatewayIdentify;

		if (this.options.initialPresence) Object.assign(data.d, { presence: this._checkPresenceData(this.options.initialPresence) });
		return this.betterWs.sendMessage(data);
	}

	/**
	 * Send an OP 6 RESUME to the gateway.
	 */
	public async resume(): Promise<void> {
		if (this.betterWs.status !== 1) return void this.client.emit("error", `Shard ${this.id} was attempting to resume when the ws was not open`);
		this.client.emit("debug", `Shard ${this.id} is resuming`);
		this.status = "resuming";
		this.emit("stateChange", "resuming");
		return this.betterWs.sendMessage({
			op: OP.RESUME,
			d: { seq: this.seq, token: this.options.token, session_id: this.sessionId! }
		});
	}

	/**
	 * Send an OP 1 HEARTBEAT to the gateway.
	 */
	private heartbeat(): void {
		if (this.betterWs.status !== 1) return void this.client.emit("error", `Shard ${this.id} was attempting to heartbeat when the ws was not open`);
		this.betterWs.sendMessage({ op: OP.HEARTBEAT, d: this.seq });
		this.lastHeartbeatSend = Date.now();
	}

	/**
	 * Handle dispatch events.
	 * @param message Message received from the websocket.
	 */
	private handleDispatch(message: import("../Types").IGatewayDispatch): void {
		this.client.emit("dispatch", message);

		if (message.s) { // sequence is from dispatch
			if (message.s > this.seq + 1) {
				this.client.emit("debug", `Shard ${this.id} invalid sequence: { current: ${this.seq} message: ${message.s} }`);
				this.seq = message.s;
				this.resume();
			}
			this.seq = message.s;
		}
		switch (message.t) {
		case "READY":
		case "RESUMED":
			if (message.t === "READY") {
				if (message.d.resume_gateway_url) this.resumeAddress = `${message.d.resume_gateway_url}?v=${GATEWAY_VERSION}&encoding=${this.options.ws?.encoding === "etf" ? "etf" : "json"}${this.options.ws?.compress ? "&compress=zlib-stream" : ""}`;
				this.sessionId = message.d.session_id;
			}
			this.status = "ready";
			this.emit("stateChange", "ready");
			this._trace = (message.d as unknown as { _trace: string })._trace;
			this.emit("ready", message.t === "RESUMED");
			break;
		default:
			void 0;
		}
	}

	/**
	 * Handle a close from the underlying websocket.
	 * @param code Websocket close code.
	 * @param reason Close reason if any.
	 */
	private handleWsClose(code: number, reason: string): void {
		let gracefulClose = false;
		this.status = "disconnected";
		this.emit("stateChange", "disconnected");
		this.clearHeartBeat();

		// Disallowed Intents.
		if (code === 4014) {
			this.betterWs.address = this.identifyAddress;
			this.client.emit("error", "Disallowed Intents, check your client options and application page.");
		}

		// Invalid Intents.
		if (code === 4013) {
			this.betterWs.address = this.identifyAddress;
			this.client.emit("error", "Invalid Intents data, check your client options.");
		}

		// Invalid API version.
		if (code === 4012) {
			this.betterWs.address = this.identifyAddress;
			this.client.emit("error", "Invalid API version.");
		}

		// Sharding required.
		if (code === 4011) {
			this.betterWs.address = this.identifyAddress;
			this.client.emit("error", "Shard would be on over 2500 guilds. Add more shards.");
		}

		// Invalid shard.
		if (code === 4010) {
			this.betterWs.address = this.identifyAddress;
			this.client.emit("error", "Invalid sharding data, check your client options.");
		}

		// Session timed out.
		// force identify if the session is marked as invalid.
		if (code === 4009) {
			this.client.emit("error", "Session timed out.");
			this.betterWs.address = this.identifyAddress;
			this.connect();
		}

		// Rate limited.
		if (code === 4008) {
			this.client.emit("error", "You are being rate limited. Wait before sending more packets.");
			if (this.resumeAddress) this.betterWs.address = this.resumeAddress;
			else this.betterWs.address = this.identifyAddress;
			this.connect();
		}

		// Invalid sequence.
		if (code === 4007) {
			this.client.emit("error", "Invalid sequence. Reconnecting and starting a new session.");
			this.reset();
			this.betterWs.address = this.identifyAddress;
			this.connect();
		}

		// Already authenticated.
		if (code === 4005) {
			this.client.emit("error", "You sent more than one OP 2 IDENTIFY payload while the websocket was open.");
			if (this.resumeAddress) this.betterWs.address = this.resumeAddress;
			this.connect();
		}

		// Authentication failed.
		if (code === 4004) {
			this.betterWs.address = this.identifyAddress;
			this.client.emit("error", "Tried to connect with an invalid token");
		}

		// Not authenticated.
		if (code === 4003) {
			this.client.emit("error", "You tried to send a packet before sending an OP 2 IDENTIFY or OP 6 RESUME.");
			if (this.resumeAddress) this.betterWs.address = this.resumeAddress;
			else this.betterWs.address = this.identifyAddress;
			this.connect();
		}

		// Decode error.
		if (code === 4002) {
			this.client.emit("error", "You sent an invalid payload");
			if (this.resumeAddress) this.betterWs.address = this.resumeAddress;
			else this.betterWs.address = this.identifyAddress;
			this.connect();
		}

		// Invalid opcode.
		if (code === 4001) {
			this.client.emit("error", "You sent an invalid opcode or invalid payload for an opcode");
			if (this.resumeAddress) this.betterWs.address = this.resumeAddress;
			else this.betterWs.address = this.identifyAddress;
			this.connect();
		}

		// Generic error / safe self closing code.
		if (code === 4000) {
			if (this.reconnecting) gracefulClose = true;
			else {
				this.client.emit("error", "Error code 4000 received. Attempting to resume");
				if (this.resumeAddress) this.betterWs.address = this.resumeAddress;
				else this.betterWs.address = this.identifyAddress;
				this.connect();
			}
		}

		// Don't try to reconnect when true
		if (code === 1000 && this._closing) gracefulClose = true;
		this._closing = false;

		this.emit("disconnect", code, reason, gracefulClose);
	}

	/**
	 * Send an OP 3 PRESENCE_UPDATE to the gateway.
	 * @param data Presence data to send.
	 */
	public async presenceUpdate(data: Partial<GatewayPresenceUpdateData>): Promise<void> {
		return this.betterWs.sendMessage({ op: OP.PRESENCE_UPDATE, d: this._checkPresenceData(data) });
	}

	/**
	 * Send an OP 4 VOICE_STATE_UPDATE to the gateway.
	 * @param data Voice state update data to send.
	 */
	public async voiceStateUpdate(data: GatewayVoiceStateUpdateData & { self_deaf?: boolean; self_mute?: boolean; }): Promise<void> {
		if (!data) return Promise.resolve();
		return this.betterWs.sendMessage({ op: OP.VOICE_STATE_UPDATE, d: this._checkVoiceStateUpdateData(data) });
	}

	/**
	 * Send an OP 8 REQUEST_GUILD_MEMBERS to the gateway.
	 * @param data Data to send.
	 */
	public async requestGuildMembers(data: GatewayRequestGuildMembersData & { limit?: number; }): Promise<void> {
		return this.betterWs.sendMessage({ op: OP.REQUEST_GUILD_MEMBERS, d: this._checkRequestGuildMembersData(data) });
	}

	/**
	 * Checks presence data and fills in missing elements.
	 * @param data Data to send.
	 * @returns Data after it's fixed/checked.
	 */
	private _checkPresenceData(data: Parameters<DiscordConnector["presenceUpdate"]>["0"]): GatewayPresenceUpdateData {
		data.status = data.status ?? PresenceUpdateStatus.Online;
		data.activities = data.activities && Array.isArray(data.activities) ? data.activities : [];

		if (data.activities) {
			for (const activity of data.activities) {
				const index = data.activities.indexOf(activity);
				if (activity.type === undefined) activity.type = activity.url ? 1 : 0;
				if (!activity.name) {
					if (activity.state && activity.type === 4) activity.name = "Custom Status"; // Discord requires name to not be empty even on custom status
					else data.activities.splice(index, 1);
				}
			}
		}

		data.afk = data.afk ?? false;
		data.since = data.since ?? Date.now();
		return data as GatewayPresenceUpdateData;
	}

	/**
	 * Checks voice state update data and fills in missing elements.
	 * @param data Data to send.
	 * @returns Data after it's fixed/checked.
	 */
	private _checkVoiceStateUpdateData(data: Parameters<DiscordConnector["voiceStateUpdate"]>["0"]): GatewayVoiceStateUpdateData {
		data.channel_id = data.channel_id ?? null;
		data.self_mute = data.self_mute ?? false;
		data.self_deaf = data.self_deaf ?? false;
		return data;
	}

	/**
	 * Checks request guild members data and fills in missing elements.
	 * @param data Data to send.
	 * @returns Data after it's fixed/checked.
	 */
	private _checkRequestGuildMembersData(data: Parameters<DiscordConnector["requestGuildMembers"]>["0"]): GatewayRequestGuildMembersData {
		const withQuery = data as GatewayRequestGuildMembersDataWithQuery;
		const withUserIDs = data as GatewayRequestGuildMembersDataWithUserIds;
		if (!withQuery.query && !withUserIDs.user_ids) withQuery.query = "";
		if (withQuery.query && withUserIDs.user_ids) delete (data as { query?: string; }).query; // the intention may be to get users by ID
		data.limit = data.limit ?? 10;
		return data;
	}
}

export = DiscordConnector;
