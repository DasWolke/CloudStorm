import Shard = require("./Shard");
import { Bucket, IntervalCounter } from "snowtransfer";

import { IShardResumeData } from "./Types";
import { clientError, safeEmit } from "./safeEmit";

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
	public shards: Record<string, Shard> = {};
	/** The bucket used to identify a certain number of shards within a day. */
	public identifyBucket = new Bucket([new IntervalCounter(1000, 1000 * 60 * 60 * 24)]);
	/** The buckets used to identify x number of shards within 5 second intervals. Larger bots benefit from this, but doesn't change how many times per day any shards can identify. */
	public concurrencyBuckets: Record<string, Bucket> = {};

	private readonly _clientError = (error: Error): void => clientError(this.client, error);

	/**
	 * Create a new ShardManager.
	 */
	public constructor(public client: import("./Client")) {
		this.options = client.options;
	}

	/**
	 * Create shard instances and add them to the connection queue.
	 * @since 0.1.4
	 */
	public spawn(): void {
		if (!Object.keys(this.concurrencyBuckets).length) throw new Error("Trying to spawn shards without calling Client.fetchConnectInfo()\nIf you intended to just let cloudstorm handle things for you, you should just use Client.connect() instead");
		for (const id of (this.options.shards === "auto" ? Array.from({ length: this.options.totalShards ?? 1 }, (_, index) => index) : this.options.shards ?? [0])) {
			if (this.shards[id]) {
				// Spawned by an earlier connect. Replacing it would orphan a live shard and its session
				this.shards[id].connect();
				continue;
			}
			safeEmit(this._clientError, () => this.client.emit("debug", `Spawned shard ${id}`));
			this.shards[id] = new Shard(id, this.client);
			const resume = this.options.resumeData?.[id];
			if (resume?.sessionId) {
				safeEmit(this._clientError, () => this.client.emit("debug", `Shard ${id} was seeded with resume data and will try to resume session ${resume.sessionId}`));
				this.shards[id].connector.seedResumeData(resume);
			}
			this._addListener(this.shards[id]);
			this.shards[id].connector.connect();
		}
	}

	/**
	 * Disconnect all shards facilitated by this manager.
	 * @since 0.1.4
	 * @param resumable Whether to close with a code that keeps the sessions alive for a later resume. See DiscordConnector.disconnect.
	 */
	public disconnect(resumable = false): void {
		const shards = Object.values(this.shards);
		// Shards without a connection (never connected, or dead from a fatal close code) have nothing to close and never report back
		const anyOpen = shards.some(shard => shard.connector.betterWs.sm.currentStateName !== "disconnected");
		for (const shard of shards) {
			shard.disconnect(resumable).catch(this._clientError);
		}
		if (!anyOpen) queueMicrotask(() => safeEmit(this._clientError, () => this.client.emit("disconnected")));
	}

	/**
	 * Collect the resume data of every shard that has a session to resume, keyed by shard id.
	 * @since 0.19.0
	 */
	public getResumeData(): Record<number, IShardResumeData> {
		const data: Record<number, IShardResumeData> = {};
		for (const shard of Object.values(this.shards)) {
			const resume = shard.connector.getResumeData();
			if (resume) data[shard.id] = resume;
		}
		return data;
	}

	/**
	 * Add event listeners to a shard to that the manager can act on received events.
	 * @since 0.1.4
	 * @param shard Shard to add the event listeners to.
	 */
	private _addListener(shard: Shard): void {
		shard.on("ready", (resume) => {
			shard.ready = true;
			safeEmit(this._clientError, () => this.client.emit("debug", `Shard ${shard.id} ${resume ? "has resumed" : "is ready"}`));
			safeEmit(this._clientError, () => this.client.emit("shardReady", { id: shard.id, ready: !resume }));
			this._checkReady();
		});
		shard.on("queueIdentify", (shardId) => {
			safeEmit(this._clientError, () => this.client.emit("debug", `Shard ${shardId} is ready to identify`));
			this.identifyBucket.enqueue(async () => {
				const max_concurrency = Object.keys(this.concurrencyBuckets).length;
				const concurrencyRoute = shardId % max_concurrency;
				const bkt = this.concurrencyBuckets[concurrencyRoute];
				if (!bkt) {
					const error = new Error(`Received a queueIdentify event for shard ${shardId} and a concurrency route of ${concurrencyRoute} with a max_concurrency of ${max_concurrency}, but there was no bucket with that route internally.`);
					this._clientError(error);
					return;
				}
				bkt.enqueue(async () => shard.connector.identify()).catch(this._clientError);
			}).catch(this._clientError);
		});
		shard.on("disconnect", (code, reason, _gracefulClose, manual) => {
			safeEmit(this._clientError, () => this.client.emit("debug", `Websocket of shard ${shard.id} closed with code ${code} and reason: ${reason ?? "None"}`));
			// Only user-requested disconnects count towards the "disconnected" event. gracefulClose alone
			// also covers internal reconnects, which pass through disconnected for only a moment.
			if (manual) return this._checkDisconnect();
		});
	}

	/**
	 * Checks if all shards spawned by this manager are ready.
	 * @since 0.1.4
	 */
	private _checkReady(): void {
		if (Object.values(this.shards).every(shard => shard.ready)) safeEmit(this._clientError, () => this.client.emit("ready"));
	}

	/**
	 * Checks if all shards spawned by this manager are disconnected.
	 * @since 0.1.4
	 */
	private _checkDisconnect(): void {
		if (Object.values(this.shards).every(shard => shard.connector.status === "disconnected")) safeEmit(this._clientError, () => this.client.emit("disconnected"));
	}

	/**
	 * Look up a shard by id, ensure it can send, and run an action with it.
	 * @since 0.19.0
	 * @param shardId id of the shard.
	 * @param action What to do with the shard.
	 */
	private _withReadyShard<T>(shardId: number, action: (shard: Shard) => Promise<T>): Promise<T> {
		const shard = this.shards[shardId];
		if (!shard) return Promise.reject(new Error(`Shard ${shardId} does not exist`));
		if (!shard.ready) return Promise.reject(new Error(`Shard ${shardId} is not ready`));
		return action(shard);
	}

	/**
	 * Update the status of all currently connected shards which have been spawned by this manager.
	 * @since 0.3.0
	 * @param data Data to send.
	 */
	public async presenceUpdate(data: Parameters<Shard["presenceUpdate"]>["0"]): Promise<void> {
		// Collected with Promise.all so a not-ready shard rejects this promise instead of floating as an unhandled rejection
		await Promise.all(Object.values(this.shards).map(shard => this.shardPresenceUpdate(shard.id, data)));
	}

	/**
	 * Update the status of a single connected shard which has been spawned by this manager.
	 * @since 0.3.0
	 * @param shardId id of the shard.
	 * @param data Data to send.
	 */
	public shardPresenceUpdate(shardId: number, data: Parameters<Shard["presenceUpdate"]>["0"]): Promise<void> {
		return this._withReadyShard(shardId, shard => shard.presenceUpdate(data));
	}

	/**
	 * Send an OP 4 VOICE_STATE_UPDATE with a certain shard.
	 * @since 0.1.4
	 * @param shardId id of the shard.
	 * @param data Data to send.
	 */
	public voiceStateUpdate(shardId: number, data: Parameters<Shard["voiceStateUpdate"]>["0"]): Promise<void> {
		return this._withReadyShard(shardId, shard => shard.voiceStateUpdate(data));
	}

	/**
	 * Send an OP 8 REQUEST_GUILD_MEMBERS with a certain shard.
	 * @since 0.1.4
	 * @param shardId id of the shard.
	 * @param data Data to send.
	 */
	public requestGuildMembers(shardId: number, data: Parameters<Shard["requestGuildMembers"]>["0"]): Promise<void> {
		return this._withReadyShard(shardId, shard => shard.requestGuildMembers(data));
	}

	/**
	 * Send an OP 31 REQUEST_SOUNDBOARD_SOUNDS with a certain shard.
	 * @since 0.19.0
	 * @param shardId id of the shard.
	 * @param guilds The guilds to get the soundboard sounds from.
	 */
	public requestSoundboardSounds(shardId: number, guilds: Parameters<Shard["requestSoundboardSounds"]>["0"]): Promise<void> {
		return this._withReadyShard(shardId, shard => shard.requestSoundboardSounds(guilds));
	}

	/**
	 * Send an OP 43 REQUEST_CHANNEL_INFO with a certain shard.
	 * @since 0.19.0
	 * @param shardId id of the shard.
	 * @param data Data to send.
	 */
	public requestChannelInfo(shardId: number, data: Parameters<Shard["requestChannelInfo"]>["0"]): Promise<void> {
		return this._withReadyShard(shardId, shard => shard.requestChannelInfo(data));
	}
}

export = ShardManager;
