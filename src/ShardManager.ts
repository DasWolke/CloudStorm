"use strict";

import Shard = require("./Shard");
import RatelimitBucket = require("./structures/RatelimitBucket");

/**
 * Class used for managing shards for the user.
 *
 * This class is automatically instantiated by the library and is documented for reference.
 */
class ShardManager {
	public client: import("events").EventEmitter & { options: Omit<import("./Types").IClientOptions, "snowtransferInstance"> & { token: string; endpoint?: string; } };
	public options: ShardManager["client"]["options"];
	public shards: { [id: number]: Shard };
	public identifyBucket: RatelimitBucket;
	public concurrencyBucket: RatelimitBucket | null = null;

	/**
	 * Create a new ShardManager.
	 */
	public constructor(client: ShardManager["client"]) {
		this.client = client;
		this.options = client.options;
		this.shards = {};
		this.identifyBucket = new RatelimitBucket(1000, 1000 * 60 * 60 * 24, 1000 * 60 * 60 * 24);
	}

	/**
	 * Create shard instances and add them to the connection queue.
	 */
	public spawn(): void {
		if (!this.concurrencyBucket) throw new Error("Trying to spawn shards without calling Client.connect()");
		for (const id of (this.options.shards === "auto" ? Array(this.options.totalShards).fill(0).map((_, index) => index) : this.options.shards || [0])) {
			this.client.emit("debug", `Spawned shard ${id}`);
			this.shards[id] = new Shard(id, this.client);
			this._addListener(this.shards[id]);
			this.shards[id].connector.connect();
		}
	}

	/**
	 * Disconnect all shards facilitated by this manager.
	 */
	public disconnect(): void {
		for (const shardKey in this.shards) {
			this.shards[shardKey].disconnect();
		}
	}

	/**
	 * Add event listeners to a shard to that the manager can act on received events.
	 * @param shard Shard to add the event listeners to.
	 */
	private _addListener(shard: Shard) {
		shard.on("ready", (resume) => {
			shard.ready = true;
			this.client.emit("debug", `Shard ${shard.id} ${resume ? "has resumed" : "is ready"}`);
			this.client.emit("shardReady", { id: shard.id, ready: !resume });
			this._checkReady();
		});
		shard.on("queueIdentify", (shardId) => {
			if (!this.shards[shardId]) return this.client.emit("debug", `Received a queueIdentify event for shard ${shardId} but it does not exist. Was it removed?`);
			this.client.emit("debug", `Shard ${shardId} is ready to identify`);
			this.concurrencyBucket?.queue(() => {
				this.identifyBucket.queue(() => this.shards[shardId].connector.identify());
			});
		});
		shard.on("disconnect", (code, reason, gracefulClose) => {
			this.client.emit("debug", `Websocket of shard ${shard.id} closed with code ${code} and reason: ${reason ? reason : "None"}`);
			if (code === 1000 && gracefulClose) return this._checkDisconnect();
		});
	}

	/**
	 * Checks if all shards spawned by this manager are ready.
	 */
	private _checkReady() {
		for (const shardId in this.shards) {
			if (this.shards[shardId]) {
				if (!this.shards[shardId].ready) return;
			}
		}
		this.client.emit("ready");
	}

	/**
	 * Checks if all shards spawned by this manager are disconnected.
	 */
	private _checkDisconnect() {
		for (const shardId in this.shards) {
			if (this.shards[shardId]) {
				if (this.shards[shardId].connector.status !== "disconnected") return;
			}
		}
		this.client.emit("disconnected");
	}

	/**
	 * Update the status of all currently connected shards which have been spawned by this manager.
	 * @param data Data to send.
	 */
	public async presenceUpdate(data: import("discord-typings").GatewayPresenceUpdate) {
		for (const shardKey in this.shards) {
			if (this.shards[shardKey]) {
				const shard = this.shards[shardKey];
				this.shardPresenceUpdate(shard.id, data);
			}
		}
	}

	/**
	 * Update the status of a single connected shard which has been spawned by this manager.
	 * @param shardId id of the shard.
	 * @param data Data to send.
	 */
	public shardPresenceUpdate(shardId: number, data: import("discord-typings").GatewayPresenceUpdate): Promise<void> {
		return new Promise((res, rej) => {
			const shard = this.shards[shardId];
			if (!shard) rej(new Error(`Shard ${shardId} does not exist`));
			if (!shard.ready) shard.once("ready", () => shard.presenceUpdate(data).then(result => res(result)).catch(e => rej(e)));
			shard.presenceUpdate(data).then(result => res(result)).catch(e => rej(e));
		});
	}

	/**
	 * Send an OP 4 VOICE_STATE_UPDATE with a certain shard.
	 * @param shardId id of the shard.
	 * @param data Data to send.
	 */
	public voiceStateUpdate(shardId: number, data: import("discord-typings").VoiceStateUpdatePayload & { self_deaf?: boolean; self_mute?: boolean; }): Promise<void> {
		return new Promise((res, rej) => {
			const shard = this.shards[shardId];
			if (!shard) rej(new Error(`Shard ${shardId} does not exist`));
			if (!shard.ready) shard.once("ready", () => shard.voiceStateUpdate(data).then(result => res(result)).catch(e => rej(e)));
			shard.voiceStateUpdate(data).then(result => res(result)).catch(e => rej(e));
		});
	}

	/**
	 * Send an OP 8 REQUEST_GUILD_MEMBERS with a certain shard.
	 * @param shardId id of the shard.
	 * @param data Data to send.
	 */
	public requestGuildMembers(shardId: number, data: import("discord-typings").GuildRequestMembersPayload & { limit?: number; }): Promise<void> {
		return new Promise((res, rej) => {
			const shard = this.shards[shardId];
			if (!shard) rej(new Error(`Shard ${shardId} does not exist`));
			if (!shard.ready) shard.once("ready", () => shard.requestGuildMembers(data).then(result => res(result)).catch(e => rej(e)));
			shard.requestGuildMembers(data).then(result => res(result)).catch(e => rej(e));
		});
	}
}

export = ShardManager;
