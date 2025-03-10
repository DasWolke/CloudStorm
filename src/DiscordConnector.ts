"use strict";

import { EventEmitter } from "events";
import BetterWs = require("./BetterWs");
import { GATEWAY_OP_CODES as OP, GATEWAY_VERSION } from "./Constants";
import Intents = require("./Intents");

import {
	type GatewayReceivePayload,
	type GatewayIdentify,
	type GatewayPresenceUpdateData,
	type GatewayVoiceStateUpdateData,
	type GatewayRequestGuildMembersData,
	type GatewayRequestGuildMembersDataWithQuery,
	type GatewayRequestGuildMembersDataWithUserIds,

	PresenceUpdateStatus
} from "discord-api-types/v10";

import type {
	ConnectorEvents,
	ClientEvents,
	IClientOptions,
	IGatewayMessage,
	IGatewayDispatch
} from "./Types";

const resumableCodes = [4008, 4005, 4003, 4002, 4001, 4000, 1006, 1001];
const shouldntAttemptReconnectCodes = [4014, 4013, 4012, 4011, 4010, 4004];
const disconnectMessages = {
	4014: "Disallowed Intents, check your client options and application page.",
	4013: "Invalid Intents data, check your client options.",
	4012: "Invalid API version.",
	4011: "Shard would be on over 2500 guilds. Add more shards.",
	4010: "Invalid sharding data, check your client options.",
	4009: "Session timed out.",
	4008: "You are being rate limited. Wait before sending more packets.",
	4007: "Invalid sequence. Reconnecting and starting a new session.",
	4005: "You sent more than one OP 2 IDENTIFY payload while the websocket was open.",
	4004: "Tried to connect with an invalid token.",
	4003: "You tried to send a packet before sending an OP 2 IDENTIFY or OP 6 RESUME.",
	4002: "You sent an invalid payload.",
	4001: "You sent an invalid opcode or invalid payload for an opcode."
};

const connectionError = new Error("WS took too long to connect. Is your internet okay?");

const wsStatusTypes = ["Whatever 0 is. Report if you see this", "connected", "connecting", "closing", "closed"];

/**
 * Class used for acting based on received events.
 *
 * This class is automatically instantiated by the library and is documented for reference.
 * @since 0.1.4
 */
class DiscordConnector extends EventEmitter<ConnectorEvents> {
	/** The options used by the client */
	public options: DiscordConnector["client"]["options"];
	/** If this connector will attempt to automatically reconnect */
	public reconnect: boolean;
	/** The WebSocket this connector uses */
	public betterWs: BetterWs;
	/** A Timeout that, when triggered, will send an op 1 heartbeat. Is null if Discord hasn't told this connector how often to heartbeat */
	public heartbeatTimeout: NodeJS.Timeout | null = null;
	/** How often this connector should heartbeat if not 0 */
	public heartbeatInterval = 0;
	/** The _trace as sent by the Discord READY and RESUMED payloads */
	public _trace: string | null = null;
	/** The sequence, which is the number of events received by Discord within the session if any session */
	public seq = 0;
	/** The status of this connector */
	public status: "connecting" | "identifying" | "resuming" | "ready" | "disconnected" = "disconnected";
	/** The session ID used for resuming or null if Discord hasn't sent one yet */
	public sessionId: string | null = null;
	/** The ms timestamp when this connector last received an op 11 heartbeat ack if not 0 */
	public lastACKAt = 0;
	/** The ms timestamp when this connector last sent an op 1 heartbeat if not 0 */
	public lastHeartbeatSend = 0;
	/** The time in milliseconds it took for Discord to send an op 11 heartbeat ack in response to an op 1 heartbeat */
	public latency = 0;
	/** The address the WebSocket will use to connect to the Discord gateway if not resuming */
	public identifyAddress: string;
	/** The address the WebSocket will use to connect to the Discord gateway if resuming */
	public resumeAddress: string | null = null;
	/** If this connector is disconnected/disconnecting currently, but will reconnect eventually */
	public reconnecting = false;

	/** If this connector is waiting to be fully closed */
	private _closing = false;
	/** If the disconnect method on this class was called and the connect method hasn't been called yet */
	private _closeCalled = false;
	/** A Timeout that, when triggered, closes the connection because op HELLO hasn't been received and may never be received */
	private _openToHeartbeatTimeout: NodeJS.Timeout | null = null;
	/** A Timeout that, when triggered, sends the first heartbeat */
	private _initialHeartbeatTimeout: NodeJS.Timeout | null = null;

	/**
	 * Creates a new Discord Connector.
	 * @param id id of the shard that created this class.
	 * @param client Main client instance.
	 */
	public constructor(public id: number, public client: EventEmitter<ClientEvents> & { options: Omit<IClientOptions, "snowtransferInstance"> & { token: string; endpoint?: string; } }) {
		super();

		this.options = client.options;
		this.reconnect = this.options.reconnect ?? true;
		this.identifyAddress = this.options.endpoint!;

		this.betterWs = new BetterWs(this.identifyAddress, this.options.ws!);

		this.betterWs.on("ws_open", () => {
			this.status = "connecting";
			this.emit("stateChange", "connecting");
			this.reconnecting = false;
			this._openToHeartbeatTimeout = setTimeout(() => {
				this.client.emit("debug", `Shard ${this.id} didn't receive a HELLO after the ws was opened in time`);
				this._reconnect(true);
			}, 10000);
		});
		this.betterWs.on("ws_receive", msg => this.messageAction(msg));
		this.betterWs.on<"ws_close">("ws_close", (code, reason) => this.handleWsClose(code, reason));
		this.betterWs.on("debug", event => this.client.emit("error", event));
		this.betterWs.on("ws_send", data => this.client.emit("rawSend", data));
	}

	/**
	 * Connect to Discord.
	 * @since 0.1.4
	 */
	public async connect(): Promise<void> {
		this._closing = false;
		this._closeCalled = false;
		this.client.emit("debug", `Shard ${this.id} connecting to gateway`);
		// The address should already be updated if resuming/identifying
		return this.betterWs.connect()
			.catch(e => { // All errors unless irrecoverable should attempt to reconnect
				if (e === connectionError) return;
				setTimeout(() => {
					if (!this._closeCalled) this.connect();
				}, 5000);
			});
	}

	/**
	 * Close the websocket connection and disconnect.
	 * @since 0.1.4
	 */
	public async disconnect(): Promise<void> {
		this._closing = true;
		this._closeCalled = true;
		return this.betterWs.close(1000, "Disconnected by User");
	}

	/**
	 * Called with a parsed Websocket message to execute further actions.
	 * @since 0.1.4
	 * @param message Message that was received.
	 */
	private async messageAction(message: GatewayReceivePayload): Promise<void> {
		this.client.emit("rawReceive", message);
		const withShardID: IGatewayMessage = Object.assign(message, { shard_id: this.id });
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
			if (this.reconnect) this._reconnect(true);
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
			if (this._openToHeartbeatTimeout) clearTimeout(this._openToHeartbeatTimeout);
			this.client.emit("debug", `Shard ${this.id} received HELLO`);
			this.lastACKAt = Date.now();
			this.heartbeatInterval = withShardID.d.heartbeat_interval;
			this._initialHeartbeatTimeout = setTimeout(() => this.heartbeat(), this.heartbeatInterval * Math.random());
			this._trace = (withShardID.d as unknown as { _trace: string })._trace;
			this._onHello();
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
	 * @since 0.3.0
	 * @param resume Whether or not the client intends to send an OP 6 RESUME later.
	 */
	private async _reconnect(resume = false): Promise<void> {
		this.reconnecting = resume;
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
	 * @since 0.1.4
	 */
	private reset(): void {
		this.sessionId = null;
		this.seq = 0;
		this.lastACKAt = 0;
		this._trace = null;
		this.clearHeartBeat();
	}

	/**
	 * Sets the this.heartbeatTimeout Interval.
	 * @since 0.8.5
	 */
	private setHeartBeat(): void {
		this.heartbeatTimeout = setInterval(() => {
			if (this.lastACKAt <= Date.now() - (this.heartbeatInterval + 5000)) {
				this.client.emit("debug", `Shard ${this.id} has not received a heartbeat ACK in ${this.heartbeatInterval + 5000}ms.`);
				if (this.reconnect) this._reconnect(true);
				else this.disconnect();
			} else this.heartbeat();
		}, this.heartbeatInterval);
	}

	/**
	 * Clear the heart beat interval, set it to null and set the cached heartbeat_interval as 0.
	 * @since 0.3.0
	 */
	private clearHeartBeat(): void {
		if (this.heartbeatTimeout) clearInterval(this.heartbeatTimeout);
		if (this._initialHeartbeatTimeout) clearTimeout(this._initialHeartbeatTimeout);
		this.heartbeatTimeout = null;
		this._initialHeartbeatTimeout = null;
		this.heartbeatInterval = 0;
	}

	/**
	 * @since 0.10.0
	 */
	private _onHello(): void {
		if (this.sessionId) return void this.resume();
		else this.emit("queueIdentify", this.id);
	}

	/**
	 * Send an OP 2 IDENTIFY to the gateway.
	 * @since 0.1.4
	 */
	public async identify(): Promise<void> {
		if (this.betterWs.status !== 1) {
			this.client.emit("error", `Shard ${this.id} was attempting to identify when the ws was not open. Was ${wsStatusTypes[this.betterWs.status]}`);
			return this._reconnect(true);
		}
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

		if (this.options.initialPresence) data.d.presence = this._checkPresenceData(this.options.initialPresence);
		return this.betterWs.sendMessage(data);
	}

	/**
	 * Send an OP 6 RESUME to the gateway.
	 * @since 0.1.4
	 */
	public async resume(): Promise<void> {
		if (this.betterWs.status !== 1) {
			this.client.emit("error", `Shard ${this.id} was attempting to resume when the ws was not open. Was ${wsStatusTypes[this.betterWs.status]}`);
			return this._reconnect(true);
		}
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
	 * @since 0.1.4
	 */
	private heartbeat(): void {
		if (this.betterWs.status !== 1) {
			this.client.emit("error", `Shard ${this.id} was attempting to heartbeat when the ws was not open. Was ${wsStatusTypes[this.betterWs.status]}`);
			return void this._reconnect(true);
		}
		this.betterWs.sendMessage({ op: OP.HEARTBEAT, d: this.seq === 0 ? null : this.seq });
		this.lastHeartbeatSend = Date.now();
		if (this._initialHeartbeatTimeout) {
			clearTimeout(this._initialHeartbeatTimeout);
			this._initialHeartbeatTimeout = null;
		}
		if (!this.heartbeatTimeout) this.setHeartBeat();
	}

	/**
	 * Handle dispatch events.
	 * @since 0.1.4
	 * @param message Message received from the websocket.
	 */
	private handleDispatch(message: IGatewayDispatch): void {
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
	 * @since 0.1.4
	 * @param code Websocket close code.
	 * @param reason Close reason if any.
	 */
	private handleWsClose(code: number, reason: string): void {
		let gracefulClose = false;
		this.status = "disconnected";
		this.emit("stateChange", "disconnected");
		this.clearHeartBeat();

		const isManualClose = code === 1000 && this._closing;

		const message = disconnectMessages[code as keyof typeof disconnectMessages];
		const isRecoverable = resumableCodes.includes(code);
		const shouldntReconnect = shouldntAttemptReconnectCodes.includes(code) || isManualClose;

		if (isRecoverable && this.resumeAddress) this.betterWs.address = this.resumeAddress;
		else this.betterWs.address = this.identifyAddress;

		if (message) this.client.emit("error", message);

		if (isManualClose || this.reconnecting) gracefulClose = true;

		this._closing = false;

		this.emit("disconnect", code, reason, gracefulClose);

		if (!shouldntReconnect && this.reconnect) this.connect();
	}

	/**
	 * Send an OP 3 PRESENCE_UPDATE to the gateway.
	 * @since 0.3.0
	 * @param data Presence data to send.
	 */
	public async presenceUpdate(data: Partial<GatewayPresenceUpdateData>): Promise<void> {
		return this.betterWs.sendMessage({ op: OP.PRESENCE_UPDATE, d: this._checkPresenceData(data) });
	}

	/**
	 * Send an OP 4 VOICE_STATE_UPDATE to the gateway.
	 * @since 0.1.4
	 * @param data Voice state update data to send.
	 */
	public async voiceStateUpdate(data: GatewayVoiceStateUpdateData & { self_deaf?: boolean; self_mute?: boolean; }): Promise<void> {
		if (!data) return Promise.resolve();
		return this.betterWs.sendMessage({ op: OP.VOICE_STATE_UPDATE, d: this._checkVoiceStateUpdateData(data) });
	}

	/**
	 * Send an OP 8 REQUEST_GUILD_MEMBERS to the gateway.
	 * @since 0.1.4
	 * @param data Data to send.
	 */
	public async requestGuildMembers(data: GatewayRequestGuildMembersData & { limit?: number; }): Promise<void> {
		return this.betterWs.sendMessage({ op: OP.REQUEST_GUILD_MEMBERS, d: this._checkRequestGuildMembersData(data) });
	}

	/**
	 * Checks presence data and fills in missing elements.
	 * @since 0.1.4
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
	 * @since 0.1.4
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
	 * @since 0.1.4
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
