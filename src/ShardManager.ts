"use strict";

import type { EventEmitter } from "events";

import Shard = require("./Shard");
import { LocalBucket } from "snowtransfer";

import {
	IClientOptions,
	ClientEvents
} from "./Types";

/**
 * Class used for managing shards for the user.
 *
 * This class is automatically instantiated by the library and is documented for reference.
 * @since 0.1.4
 */
class ShardManager {
	/** The options used by the client */
	public options: ShardManager["client"]["options"];
	/** A Record of shards keyed by their ID */
	public shards: { [id: number]: Shard } = {};
	/** The bucket used to identify a certain number of shards within a day. */
	public identifyBucket = new LocalBucket(1000, 1000 * 60 * 60 * 24);
	/** The bucket used to identify x number of shards within 5 second intervals. Larger bots benefit from this, but doesn't change how many times per day any shards can identify. */
	public concurrencyBucket: LocalBucket | null = null;

	/**
	 * Create a new ShardManager.
	 */
	public constructor(public client: EventEmitter<ClientEvents> & { options: Omit<IClientOptions, "snowtransferInstance"> & { token: string; endpoint?: string; } }) {
		this.options = client.options;
	}

	/**
	 * Create shard instances and add them to the connection queue.
	 * @since 0.1.4
	 */
	public spawn(): void {
		if (!this.concurrencyBucket) throw new Error("Trying to spawn shards without calling Client.connect()");
		for (const id of (this.options.shards === "auto" ? Array(this.options.totalShards).fill(0).map((_, index) => index) : this.options.shards ?? [0])) {
			this.client.emit("debug", `Spawned shard ${id}`);
			this.shards[id] = new Shard(id, this.client);
			this._addListener(this.shards[id]);
			this.shards[id].connector.connect();
		}
	}

	/**
	 * Disconnect all shards facilitated by this manager.
	 * @since 0.1.4
	 */
	public disconnect(): void {
		for (const shardKey in this.shards) {
			this.shards[shardKey].disconnect();
		}
	}

	/**
	 * Add event listeners to a shard to that the manager can act on received events.
	 * @since 0.1.4
	 * @param shard Shard to add the event listeners to.
	 */
	private _addListener(shard: Shard): void {
		shard.on("ready", (resume) => {
			shard.ready = true;
			this.client.emit("debug", `Shard ${shard.id} ${resume ? "has resumed" : "is ready"}`);
			this.client.emit("shardReady", { id: shard.id, ready: !resume });
			this._checkReady();
		});
		shard.on("queueIdentify", (shardId) => {
			if (!this.shards[shardId]) return this.client.emit("debug", `Received a queueIdentify event for shard ${shardId} but it does not exist. Was it removed?`);
			this.client.emit("debug", `Shard ${shardId} is ready to identify`);
			if (shard.connector.reconnecting) return shard.connector.resume();
			this.concurrencyBucket?.enqueue(() => {
				this.identifyBucket.enqueue(() => this.shards[shardId].connector.identify());
			});
		});
		shard.on("disconnect", (code, reason, gracefulClose) => {
			this.client.emit("debug", `Websocket of shard ${shard.id} closed with code ${code} and reason: ${reason ?? "None"}`);
			if (code === 1000 && gracefulClose) return this._checkDisconnect();
		});
	}

	/**
	 * Checks if all shards spawned by this manager are ready.
	 * @since 0.1.4
	 */
	private _checkReady(): void {
		for (const shardId in this.shards) {
			if (this.shards[shardId]) {
				if (!this.shards[shardId].ready) return;
			}
		}
		this.client.emit("ready");
	}

	/**
	 * Checks if all shards spawned by this manager are disconnected.
	 * @since 0.1.4
	 */
	private _checkDisconnect(): void {
		for (const shardId in this.shards) {
			if (this.shards[shardId]) {
				if (this.shards[shardId].connector.status !== "disconnected") return;
			}
		}
		this.client.emit("disconnected");
	}

	/**
	 * Update the status of all currently connected shards which have been spawned by this manager.
	 * @since 0.3.0
	 * @param data Data to send.
	 */
	public async presenceUpdate(data: Parameters<Shard["presenceUpdate"]>["0"]): Promise<void> {
		for (const shardKey in this.shards) {
			if (this.shards[shardKey]) {
				const shard = this.shards[shardKey];
				this.shardPresenceUpdate(shard.id, data);
			}
		}
	}

	/**
	 * Update the status of a single connected shard which has been spawned by this manager.
	 * @since 0.3.0
	 * @param shardId id of the shard.
	 * @param data Data to send.
	 */
	public shardPresenceUpdate(shardId: number, data: Parameters<Shard["presenceUpdate"]>["0"]): Promise<void> {
		return new Promise((res, rej) => {
			const shard = this.shards[shardId];
			if (!shard) rej(new Error(`Shard ${shardId} does not exist`));
			if (!shard.ready) return;
			shard.presenceUpdate(data).then(result => res(result)).catch(e => rej(e as Error));
		});
	}

	/**
	 * Send an OP 4 VOICE_STATE_UPDATE with a certain shard.
	 * @since 0.1.4
	 * @param shardId id of the shard.
	 * @param data Data to send.
	 */
	public voiceStateUpdate(shardId: number, data: Parameters<Shard["voiceStateUpdate"]>["0"]): Promise<void> {
		return new Promise((res, rej) => {
			const shard = this.shards[shardId];
			if (!shard) rej(new Error(`Shard ${shardId} does not exist`));
			if (!shard.ready) return;
			shard.voiceStateUpdate(data).then(result => res(result)).catch(e => rej(e as Error));
		});
	}

	/**
	 * Send an OP 8 REQUEST_GUILD_MEMBERS with a certain shard.
	 * @since 0.1.4
	 * @param shardId id of the shard.
	 * @param data Data to send.
	 */
	public requestGuildMembers(shardId: number, data: Parameters<Shard["requestGuildMembers"]>["0"]): Promise<void> {
		return new Promise((res, rej) => {
			const shard = this.shards[shardId];
			if (!shard) rej(new Error(`Shard ${shardId} does not exist`));
			if (!shard.ready) return;
			shard.requestGuildMembers(data).then(result => res(result)).catch(e => rej(e as Error));
		});
	}
}

export = ShardManager;
