"use strict";

import { EventEmitter } from "events";
import BetterWs from "../structures/BetterWs";
import { GATEWAY_OP_CODES as OP } from "../Constants";
import Intents from "../Intents";

interface ConnectorEvents {
	queueIdentify: [number];
	event: [import("../Types").IWSMessage];
	ready: [boolean];
	error: [string];
	disconnect: [number, string, boolean, boolean];
}

/**
 * Class used for acting based on received events
 *
 * This class is automatically instantiated by the library and is documented for reference
 */
class DiscordConnector extends EventEmitter {
	public id: number;
	public client: import("../Client");
	public options: import("../Client")["options"];
	public reconnect: boolean;
	public betterWs: BetterWs | null;
	public heartbeatInterval: NodeJS.Timeout | null;
	public _trace: string | null;
	public seq: number;
	public status: string;
	public sessionId: string | null;
	public forceIdentify: boolean;

	/**
	 * Create a new Discord Connector
	 * @param id id of the shard that created this class
	 * @param client Main client instance
	 */
	public constructor(id: number, client: import("../Client")) {
		super();
		this.id = id;
		this.client = client;
		this.options = client.options;
		this.reconnect = this.options.reconnect || true;
		this.betterWs = null;
		this.heartbeatInterval = null;
		this._trace = null;
		this.seq = 0;
		this.status = "init";
		this.sessionId = null;
		this.forceIdentify = false;
	}

	public emit<E extends keyof ConnectorEvents>(event: E, ...args: ConnectorEvents[E]) {
		return super.emit(event, args);
	}
	public once<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any) {
		// @ts-ignore SHUT UP!!!
		return super.once(event, listener);
	}
	public on<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any) {
		// @ts-ignore
		return super.on(event, listener);
	}

	/**
	 * Connect to discord
	 */
	public connect() {
		if (!this.betterWs) {
			this.betterWs = new BetterWs(this.options.endpoint as string);
		} else {
			this.betterWs.removeAllListeners();
			this.betterWs.recreateWs(this.options.endpoint as string);
		}
		this.betterWs.on("ws_open", () => {
			this.status = "connecting";
		});
		this.betterWs.on("ws_message", (msg) => {
			this.messageAction(msg);
		});
		this.betterWs.on("ws_close", (code, reason) => {
			this.client.emit("debug", `Websocket of shard ${this.id} closed with code ${code} and reason: ${reason}`);
			this.handleWsClose(code, reason);
		});
		this.betterWs.on("debug", event => {
			this.client.emit("debug", event);
		});
		this.betterWs.on("debug_send", data => {
			this.client.emit("rawSend", data);
		});
	}

	/**
	 * Close the websocket connection and disconnect
	 */
	public async disconnect(): Promise<void> {
		return this.betterWs?.close(1000, "Disconnect from User") || undefined;
	}

	/**
	 * Called with a parsed Websocket message to execute further actions
	 * @param message message that was received
	 */
	private messageAction(message: import("../Types").IGatewayMessage) {
		this.client.emit("rawReceive", message);
		if (message.s) {
			if (message.s > this.seq + 1) {
				this.client.emit("debug", `Shard ${this.id}, invalid sequence: current: ${this.seq} message: ${message.s}`);
				this.seq = message.s;
				this.resume();
			}
			this.seq = message.s;
		}
		switch (message.op) {
		case OP.DISPATCH:
			this.handleDispatch(message);
			break;
		case OP.HELLO:
			this.heartbeat();
			this.heartbeatInterval = setInterval(() => {
				this.heartbeat();
			}, message.d.heartbeat_interval - 5000);
			this._trace = message.d._trace;
			this.identify();
			this.client.emit("debug", `Shard ${this.id} received HELLO`);
			break;
		case OP.HEARTBEAT:
			this.heartbeat();
			break;
		case OP.HEARTBEAT_ACK:
			break;
		case OP.RECONNECT:
			this.reset();
			this.betterWs?.close();
			break;
		case OP.INVALID_SESSION:
			if (message.d && this.sessionId) {
				this.resume();
			} else {
				this.seq = 0;
				this.sessionId = "";
				this.emit("queueIdentify", this.id);
			}
			break;
		default:
			this.emit("event", message);
		}
	}

	/**
	 * Reset this connector
	 */
	private reset() {
		this.sessionId = null;
		this.seq = 0;
		this._trace = null;
		if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
		this.heartbeatInterval = null;
	}

	/**
	 * Send a identify payload to the gateway
	 * @param force Whether CloudStorm should send an IDENTIFY even if there's a session that could be resumed
	 */
	public async identify(force?: boolean): Promise<void> {
		if (this.sessionId && !this.forceIdentify && !force) {
			return this.resume();
		}
		const data = {
			op: OP.IDENTIFY, d: {
				token: this.options.token,
				properties: {
					os: process.platform,
					browser: "CloudStorm",
					device: "CloudStorm"
				},
				large_threshold: this.options.largeGuildThreshold,
				shard: [this.id, this.options.shardAmount],
				presence: this.options.initialPresence ? this._checkPresenceData(this.options.initialPresence) : null,
				intents: this.options.intents ? Intents.resolve(this.options.intents) : 0
			}
		};
		this.forceIdentify = false;
		return this.betterWs?.sendMessage(data);
	}

	/**
	 * Send a resume payload to the gateway
	 */
	private async resume(): Promise<void> {
		return this.betterWs?.sendMessage({
			op: OP.RESUME,
			d: { seq: this.seq, token: this.options.token, session_id: this.sessionId }
		});
	}

	/**
	 * Send a heartbeat to discord
	 */
	private heartbeat() {
		this.betterWs?.sendMessage({ op: OP.HEARTBEAT, d: this.seq });
	}

	/**
	 * Handle dispatch events
	 * @param message message received from the websocket
	 */
	private handleDispatch(message: import("../Types").IGatewayMessage) {
		switch (message.t) {
		case "READY":
		case "RESUMED":
			if (message.t === "READY") {
				this.sessionId = message.d.session_id;
			}
			this.status = "ready";
			this._trace = message.d._trace;
			this.emit("ready", message.t === "RESUMED");
			this.emit("event", message);
			break;
		default:
			this.emit("event", message);
		}
	}

	/**
	 * Handle a close from the underlying websocket
	 * @param code websocket close code
	 * @param reason close reason if any
	 */
	private handleWsClose(code: number, reason: string) {
		let forceIdentify = false;
		let gracefulClose = false;
		this.status = "disconnected";
		if (code === 4004) {
			this.emit("error", "Tried to connect with an invalid token");
			return;
		}
		if (code === 4010) {
			this.emit("error", "Invalid sharding data, check your client options");
			return;
		}
		if (code === 4011) {
			this.emit("error", "Shard would be on over 2500 guilds. Add more shards");
			return;
		}
		// force identify if the session is marked as invalid
		if (code === 4009) {
			forceIdentify = true;
		}
		// don't try to reconnect when true
		if (code === 1000 && reason === "Disconnect from User") {
			gracefulClose = true;
		}
		if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
		this.betterWs?.removeAllListeners();
		this.emit("disconnect", code, reason, forceIdentify, gracefulClose);
	}

	/**
	 * Send a status update payload to discord
	 * @param data presence data to send
	 */
	public async statusUpdate(data: import("../Types").IPresence = {}): Promise<void> {
		return this.betterWs?.sendMessage({ op: OP.STATUS_UPDATE, d: this._checkPresenceData(data) });
	}

	/**
	 * Send a voice state update payload to discord
	 * @param data voice state update data to send
	 */
	public async voiceStateUpdate(data: import("../Types").IVoiceStateUpdate): Promise<void> {
		if (!data) {
			return Promise.resolve();
		}
		return this.betterWs?.sendMessage({ op: OP.VOICE_STATE_UPDATE, d: this._checkVoiceStateUpdateData(data) });
	}

	/**
	 * Send a request guild members payload to discord
	 * @param data data to send
	 */
	public async requestGuildMembers(data: import("../Types").IRequestGuildMembers): Promise<void> {
		return this.betterWs?.sendMessage({ op: OP.REQUEST_GUILD_MEMBERS, d: this._checkRequestGuildMembersData(data) });
	}

	/**
	 * Checks the presence data and fills in missing elements
	 * @param data data to send
	 * @returns data after it's fixed/checked
	 */
	private _checkPresenceData(data: import("../Types").IPresence): import("../Types").IPresence {
		data.status = data.status || "online";
		data.game = data.game || null;
		if (data.game && data.game.type === undefined) {
			data.game.type = data.game.url ? 1 : 0;
		}
		if (data.game && !data.game.name) {
			data.game = null;
		}
		data.afk = data.afk || false;
		data.since = data.since || false;
		return data;
	}

	/**
	 * Checks the voice state update data and fills in missing elements
	 * @param data data to send
	 * @returns data after it's fixed/checked
	 */
	private _checkVoiceStateUpdateData(data: import("../Types").IVoiceStateUpdate): import("../Types").IVoiceStateUpdate {
		data.channel_id = data.channel_id || null;
		data.self_mute = data.self_mute || false;
		data.self_deaf = data.self_deaf || false;
		return data;
	}

	/**
	 * Checks the request guild members data and fills in missing elements
	 * @param data data to send
	 * @returns data after it's fixed/checked
	 */
	private _checkRequestGuildMembersData(data: import("../Types").IRequestGuildMembers): import("../Types").IRequestGuildMembers {
		data.query = data.query || "";
		data.limit = data.limit || 0;
		return data;
	}
}

export = DiscordConnector;
