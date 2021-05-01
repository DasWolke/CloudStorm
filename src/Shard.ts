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
 * Shard class, which provides a wrapper around the DiscordConnector with metadata like the id of the shard.
 *
 * This class is automatically instantiated by the library and is documented for reference.
 */
class Shard extends EventEmitter {
	public id: number;
	public client: import("./Client");
	public forceIdentify: boolean;
	public ready: boolean;
	public connector: DiscordConnector;

	/**
	 * Create a new Shard.
	 * @param id id of the shard.
	 * @param client Main class used for forwarding events.
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

	public emit<E extends keyof ShardEvents>(event: E, ...args: ShardEvents[E]): boolean {
		return super.emit(event, ...args);
	}
	public once<E extends keyof ShardEvents>(event: E, listener: (...args: ShardEvents[E]) => any): this {
		// @ts-ignore SHUT UP!!!
		return super.once(event, listener);
	}
	public on<E extends keyof ShardEvents>(event: E, listener: (...args: ShardEvents[E]) => any): this {
		// @ts-ignore
		return super.on(event, listener);
	}

	/**
	 * Time in ms it took for Discord to ackknowledge an OP 1 HEARTBEAT.
	 */
	public get latency(): number {
		return this.connector.latency;
	}

	/**
	 * Create a new connection to Discord.
	 */
	public connect(): void {
		if (this.forceIdentify) {
			this.connector.forceIdentify = true;
			this.forceIdentify = false;
		}
		this.connector.connect();
	}

	/**
	 * Close the current connection to Discord.
	 */
	public disconnect(): Promise<void> {
		return this.connector.disconnect();
	}

	/**
	 * Send an OP 3 PRESENCE_UPDATE to Discord.
	 * @param data Data to send.
	 */
	public presenceUpdate(data: import("./Types").IPresence): Promise<void> {
		return this.connector.presenceUpdate(data);
	}

	/**
	 * Send an OP 4 VOICE_STATE_UPDATE to Discord.
	 * @param data Data to send
	 */
	public voiceStateUpdate(data: import("./Types").IVoiceStateUpdate): Promise<void> {
		return this.connector.voiceStateUpdate(data);
	}

	/**
	 * Send an OP 8 REQUEST_GUILD_MEMBERS to Discord.
	 * @param data Data to send.
	 */
	public requestGuildMembers(data: import("./Types").IRequestGuildMembers): Promise<void> {
		return this.connector.requestGuildMembers(data);
	}
}

export = Shard;
