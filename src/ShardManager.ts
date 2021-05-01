"use strict";

import Shard from "./Shard";

/**
 * Class used for managing shards for the user.
 *
 * This class is automatically instantiated by the library and is documented for reference.
 */
class ShardManager {
	public client: import("./Client");
	public options: import("./Client")["options"];
	public shards: { [id: number]: Shard };
	public connectQueue: Array<{ action: string; shard: Shard }>;
	public lastConnectionAttempt: number | null;
	public connectQueueInterval: NodeJS.Timeout;

	/**
	 * Create a new ShardManager.
	 */
	public constructor(client: import("./Client")) {
		this.client = client;
		this.options = client.options;
		if (!this.options.connectQueueInterval) {
			this.options.connectQueueInterval = 1000 * 5;
		}
		this.shards = {};
		this.connectQueue = [];
		this.lastConnectionAttempt = null;
		this.connectQueueInterval = setInterval(() => {
			this._checkQueue();
		}, this.options.connectQueueInterval);
	}

	/**
	 * Create shard instances and add them to the connection queue.
	 */
	public spawn(): void {
		const firstShardID = this.options.firstShardId ? this.options.firstShardId : 0;
		const lastShardId = this.options.lastShardId ? this.options.lastShardId : 0;
		for (let i = firstShardID; i < lastShardId + 1; i++) {
			this.client.emit("debug", `Spawned shard ${i}`);
			this.shards[i] = new Shard(i, this.client);
			this.connectQueue.push({ action: "connect", shard: this.shards[i] });
			this._addListener(this.shards[i]);
		}
	}

	/**
	 * Disconnect all shards facilitated by this manager.
	 */
	public disconnect(): void {
		for (const shardKey in this.shards) {
			if (this.shards[shardKey]) {
				const shard = this.shards[shardKey];
				shard.disconnect();
			}
		}
	}

	/**
	 * Actually connect/re-identify a single shard spawned by this manager by calling it's connect() or identify() method and reset the connection timer.
	 * @param data Object with a shard and action key.
	 */
	private _connectShard(data: { action: string, shard: Shard }) {
		const { action, shard } = data;
		this.client.emit("debug", `${action === "connect" ? "Connecting" : "Identifying"} Shard ${shard.id} Status: ${shard.connector.status} Ready: ${shard.ready}`);
		if ((this.lastConnectionAttempt || 0) <= Date.now() - 6000) {

			if (action === "identify") {
				this.lastConnectionAttempt = Date.now();
				shard.connector.identify(true);
			} else {
				if (shard.connector.status !== "connecting" && !shard.ready) {
					this.lastConnectionAttempt = Date.now();
					shard.connect();
				}
			}
		}
	}

	/**
	 * Check if there are shards that have been spawned by this manager that are not connected yet and connect them if over 6 seconds have passed since the last attempt.
	 */
	private _checkQueue() {
		// this.client.emit("debug", `Checking queue Length: ${this.connectQueue.length} LastAttempt: ${this.lastConnectionAttempt} Current Time: ${Date.now()}`);
		if (this.connectQueue.length > 0 && ((this.lastConnectionAttempt || 0) <= Date.now() - 6000)) {
			const toConnect = this.connectQueue.splice(0, 1);
			for (const shard of toConnect) {
				this._connectShard(shard);
			}
		}
	}

	/**
	 * Add event listeners to a shard to that the manager can act on received events.
	 * @param shard Shard to add the event listeners to.
	 */
	private _addListener(shard: Shard) {
		shard.on("ready", (resume) => {
			this.shards[shard.id].ready = true;
			this.client.emit("debug", `Shard ${shard.id} ${resume ? "has resumed" : "is ready"}`);
			this.client.emit("shardReady", { id: shard.id, ready: !resume });
			this._checkReady();
		});
		shard.on("error", (error) => {
			this.client.emit("error", error);
		});

		shard.on("disconnect", (code, reason, forceIdentify, gracefulClose) => {
			this.client.emit("debug", `Websocket of shard ${shard.id} closed with code ${code} and reason: ${reason ? reason : "None"}`);
			if (code === 1000 && gracefulClose) {
				this._checkDisconnect();
				return;
			}
			shard.forceIdentify = forceIdentify;
			this.connectQueue.push({action: "connect", shard});
		});
		shard.on("queueIdentify", (shardId) => {
			if (!this.shards[shardId]) {
				this.client.emit("debug", `Received a queueIdentify event for not existing shard ${shardId}`);
				return;
			}
			this.connectQueue.unshift({action: "identify", shard: this.shards[shardId]});
		});
	}

	/**
	 * Checks if all shards spawned by this manager are ready.
	 */
	private _checkReady() {
		for (const shardId in this.shards) {
			if (this.shards[shardId]) {
				if (!this.shards[shardId].ready) {
					return;
				}
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
				if (this.shards[shardId].connector.status !== "disconnected") {
					return;
				}
			}
		}
		this.client.emit("disconnected");
	}

	/**
	 * Update the status of all currently connected shards which have been spawned by this manager.
	 * @param data Data to send.
	 */
	public async presenceUpdate(data: import("./Types").IPresence = {}) {
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
	public shardPresenceUpdate(shardId: number, data: import("./Types").IPresence = {}): Promise<void> {
		return new Promise((res, rej) => {
			const shard = this.shards[shardId];
			if (!shard) {
				rej(new Error(`Shard ${shardId} does not exist`));
			}
			if (!shard.ready) {
				shard.once("ready", () => {
					shard.presenceUpdate(data).then(result => res(result)).catch(e => rej(e));
				});
			}
			shard.presenceUpdate(data).then(result => res(result)).catch(e => rej(e));
		});
	}

	/**
	 * Send an OP 4 VOICE_STATE_UPDATE with a certain shard.
	 * @param shardId id of the shard.
	 * @param data Data to send.
	 */
	public voiceStateUpdate(shardId: number, data: import("./Types").IVoiceStateUpdate): Promise<void> {
		return new Promise((res, rej) => {
			const shard = this.shards[shardId];
			if (!shard) {
				rej(new Error(`Shard ${shardId} does not exist`));
			}
			if (!shard.ready) {
				shard.once("ready", () => {
					shard.voiceStateUpdate(data).then(result => res(result)).catch(e => rej(e));
				});
			}
			shard.voiceStateUpdate(data).then(result => res(result)).catch(e => rej(e));
		});
	}

	/**
	 * Send an OP 8 REQUEST_GUILD_MEMBERS with a certain shard.
	 * @param shardId id of the shard.
	 * @param data Data to send.
	 */
	public requestGuildMembers(shardId: number, data: import("./Types").IRequestGuildMembers): Promise<void> {
		return new Promise((res, rej) => {
			const shard = this.shards[shardId];
			if (!shard) {
				rej(new Error(`Shard ${shardId} does not exist`));
			}
			if (!shard.ready) {
				shard.once("ready", () => {
					shard.requestGuildMembers(data).then(result => res(result)).catch(e => rej(e));
				});
			}
			shard.requestGuildMembers(data).then(result => res(result)).catch(e => rej(e));
		});
	}
}

export = ShardManager;
