"use strict";

import Shard from "./Shard";

/**
 * Class used for managing shards for the user
 *
 * This class is automatically instantiated by the library and is documented for reference
 */
class ShardManager {
	public client: import("./Client");
	public options: import("./Client")["options"];
	public shards: { [id: number]: Shard };
	public connectQueue: Array<{ action: string; shard: Shard }>;
	public lastConnectionAttempt: number | null;
	public connectQueueInterval: NodeJS.Timeout;

	/**
	 * Create a new ShardManager
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
	 * Create the shard instances and add them to the connection queue
	 */
	public spawn() {
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
	 * Disconnect all shards
	 */
	public disconnect() {
		for (const shardKey in this.shards) {
			if (this.shards[shardKey]) {
				const shard = this.shards[shardKey];
				shard.disconnect();
			}
		}
	}

	/**
	 * Actually connect/re-identify a single shard by calling it's connect() or identify() method and reset the connection timer
	 * @param data Object with a shard and action key
	 */
	private _connectShard(data: { action: string, shard: Shard }) {
		const { action, shard } = data;
		this.client.emit("debug", `${action === "connect" ? "Connecting" : "Identifying"} Shard ${shard.id} Status: ${shard.connector.status} Ready: ${shard.ready}`);
		if (this.lastConnectionAttempt && (this.lastConnectionAttempt <= Date.now() - 6000)) {
			switch (action) {
			case "identify":
				this.lastConnectionAttempt = Date.now();
				this.client.emit("debug", `Identifying shard ${shard.id}`);
				shard.connector.identify(true);
				break;
			case "connect":
			default:
				if (shard.connector.status !== "connecting" && !shard.ready) {
					this.lastConnectionAttempt = Date.now();
					this.client.emit("debug", `Connecting shard ${shard.id}`);
					shard.connect();
				}
				break;
			}
		}
	}

	/**
	 * Check if there are shards that are not connected yet and connect them if over 6 seconds have passed since the last attempt
	 */
	private _checkQueue() {
		this.client.emit("debug", `Checking queue Length: ${this.connectQueue.length} LastAttempt: ${this.lastConnectionAttempt} Current Time: ${Date.now()}`);
		if (this.connectQueue.length > 0 && ((this.lastConnectionAttempt || 0) <= Date.now() - 6000)) {
			const toConnect = this.connectQueue.splice(0, 1);
			for (const shard of toConnect) {
				this._connectShard(shard);
			}
		}
	}

	/**
	 * Add event listeners to a shard to that the manager can act on received events
	 * @param shard shard to add the event listeners to
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
			this.client.emit("debug", `${shard.id} ws closed with code ${code} and reason: ${reason}`);
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
	 * Checks if all shards are ready
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
	 * Checks if all shards are disconnected
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
	 * Update the status of all currently connected shards
	 * @param data payload to send
	 */
	public async statusUpdate(data: import("./Types").IPresence = {}) {
		const shardPromises: Array<Promise<void>> = [];
		for (const shardKey in this.shards) {
			if (this.shards[shardKey]) {
				const shard = this.shards[shardKey];
				if (shard.ready) {
					shardPromises.push(shard.statusUpdate(data));
				}
			}
		}
		await Promise.all(shardPromises);
	}

	/**
	 * Update the status of a single connected shard
	 * @param shardId internal id of the shard
	 * @param data payload to send
	 */
	public shardStatusUpdate(shardId: number, data: import("./Types").IPresence = {}): Promise<void> {
		return new Promise((res, rej) => {
			const shard = this.shards[shardId];
			if (!shard) {
				rej(new Error(`Shard ${shardId} does not exist`));
			}
			if (!shard.ready) {
				shard.once("ready", () => {
					shard.statusUpdate(data).then(result => res(result)).catch(e => rej(e));
				});
			}
			shard.statusUpdate(data).then(result => res(result)).catch(e => rej(e));
		});
	}

	/**
	 * Send a voice state update payload with a certain shard
	 * @param shardId id of the shard
	 * @param data payload to send
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
	 * Send a request guild members payload with a certain shard
	 * @param shardId id of the shard
	 * @param data payload to send
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
