"use strict";

import { EventEmitter } from "events";
import DiscordConnector from "./connector/DiscordConnector";
import { GATEWAY_OP_CODES as OP_CODES } from "./Constants";

interface ShardEvents {
	disconnect: [number, string, boolean, boolean];
	error: [string];
	ready: [boolean];
	queueIdentify: [number];
}

/**
 * Shard class, which provides a wrapper around the DiscordConnector with metadata like the id of the shard
 *
 * This class is automatically instantiated by the library and is documented for reference
 */
class Shard extends EventEmitter {
	public id: number;
	public client: import("./Client");
	public forceIdentify: boolean;
	public ready: boolean;
	public connector: DiscordConnector;

	/**
	 * Create a new Shard
	 * @param id Id of the shard
	 * @param client main class used for forwarding events
	 */
	public constructor(id: number, client: import("./Client")) {
		super();

		this.id = id;
		this.client = client;
		this.forceIdentify = false;
		this.ready = false;
		this.connector = new DiscordConnector(id, client);
		this.connector.on("event", (event) => {
			const newEvent: import("./Types").IGatewayMessage = Object.assign(event, { shard_id: this.id });
			this.client.emit("event", newEvent);
			switch (event.op) {
			case OP_CODES.DISPATCH:
				this.client.emit("dispatch", newEvent);
				break;
			case OP_CODES.VOICE_STATE_UPDATE:
				this.client.emit("voiceStateUpdate", newEvent);
				break;
			default:
				break;
			}
		});
		this.connector.on("disconnect", (...args) => {
			this.ready = false;
			this.emit("disconnect", ...args);
		});
		this.connector.on("error", (err) => {
			this.emit("error", err);
		});
		this.connector.on("ready", (resume) => {
			this.emit("ready", resume);
		});
		this.connector.on("queueIdentify", () => {
			this.emit("queueIdentify", this.id);
		});
	}

	public emit<E extends keyof ShardEvents>(event: E, ...args: ShardEvents[E]) {
		return super.emit(event, ...args);
	}
	public once<E extends keyof ShardEvents>(event: E, listener: (...args: ShardEvents[E]) => any) {
		// @ts-ignore SHUT UP!!!
		return super.once(event, listener);
	}
	public on<E extends keyof ShardEvents>(event: E, listener: (...args: ShardEvents[E]) => any) {
		// @ts-ignore
		return super.on(event, listener);
	}

	/**
	 * Create a new Connection to discord
	 */
	public connect() {
		if (this.forceIdentify) {
			this.connector.forceIdentify = true;
			this.forceIdentify = false;
		}
		this.connector.connect();
	}

	/**
	 * Close the current connection
	 */
	public disconnect(): Promise<void> {
		return this.connector.disconnect();
	}

	/**
	 * Send a status update payload to discord
	 * @param data data to send
	 */
	statusUpdate(data: import("./Types").IPresence): Promise<void> {
		return this.connector.statusUpdate(data);
	}

	/**
	 * Send a voice state update payload to discord
	 * @param data data to send
	 */
	voiceStateUpdate(data: import("./Types").IVoiceStateUpdate): Promise<void> {
		return this.connector.voiceStateUpdate(data);
	}

	/**
	 * Send a request guild members payload to discord
	 * @param data data to send
	 */
	requestGuildMembers(data: import("./Types").IRequestGuildMembers): Promise<void> {
		return this.connector.requestGuildMembers(data);
	}
}

export = Shard;
