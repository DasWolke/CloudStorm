import { EventEmitter } from "node:events";
import Constants = require("./Constants");
import { SnowTransfer, Bucket, IntervalCounter } from "snowtransfer";
import ShardManager = require("./ShardManager");
import type { APIGatewayBotInfo } from "discord-api-types/v10";

import type {
	ClientEvents,
	IClientOptions,
	IShardResumeData
} from "./Types";

/**
 * Main class used for receiving events and interacting with the Discord gateway.
 * @since 0.1.4
 */
class Client extends EventEmitter<ClientEvents> {
	/** The Discord auth token to connect with. */
	public token: string;
	/** User specific options filled in with defaults if not specified. */
	public options: Omit<IClientOptions, "snowtransferInstance"> & { token: string; endpoint?: string; };
	/** The manager of all of the shards used to connect to Discord. */
	public shardManager: ShardManager;
	/** The version string of CloudStorm. */
	public version = Constants.VERSION;
	/** The SnowTransfer instance to use to make some requests to get connect info. */
	private readonly _restClient: SnowTransfer;

	/**
	 * Create a new Client to connect to the Discord gateway.
	 * @param token Token received from creating a discord bot user, which will be used to connect to the gateway.
	 * @param options Baseline options to use. Will be filled with defaults if not specified.
	 */
	public constructor(token: string, options: IClientOptions = {}) {
		super();
		if (!token) throw new Error("Missing token!");
		const { snowtransferInstance, ws, ...rest } = options;
		this._restClient = snowtransferInstance ?? new SnowTransfer(token);
		this.token = token.startsWith("Bot ") ? token.substring(4) : token;
		this.options = {
			largeGuildThreshold: 250,
			shards: "auto",
			intents: 0,
			...rest,
			token,
			ws: {
				compress: true,
				encoding: "json",
				...ws
			}
		};
		this.shardManager = new ShardManager(this);
	}

	/**
	 * Create one or more connections (depending on the selected amount of shards) to the Discord gateway.
	 * @since 0.1.4
	 * @returns This function returns a promise which is solely used for awaiting the getGateway() method's return value.
	 */
	public async connect(): Promise<void> {
		const initial = await this.fetchConnectInfo();
		if (this.options.shards === "auto") this.options.totalShards = initial;
		this.shardManager.spawn();
	}

	/**
	 * Method to grab initial connection info from Discord.
	 * Should only be called automatically by the lib unless you are a large bot with a max_concurrency not equal to 1.
	 * If you are a large bot, you should call this method at a rate of your own discretion to update your max_concurrency cached value to have up to date bucket info.
	 * @since 0.5.0
	 * @returns The amount of shards the bot should spawn if set to auto.
	 */
	public async fetchConnectInfo(): Promise<number> {
		const gateway = await this.getGatewayBot();
		this._updateEndpoint(gateway.url);
		this.shardManager.identifyBucket.counters[0].applyCount(null, gateway.session_start_limit.remaining, gateway.session_start_limit.reset_after);
		if (this.shardManager.identifyBucket.counters[0].canTake()) this.shardManager.identifyBucket.resume(); // canTake, not take: probing must not consume an identify slot
		for (const route of Object.keys(this.shardManager.concurrencyBuckets)) {
			delete this.shardManager.concurrencyBuckets[route];
		}
		for (let i = 0; i < gateway.session_start_limit.max_concurrency; i++) {
			this.shardManager.concurrencyBuckets[i] = new Bucket([new IntervalCounter(1, 5000)]);
		}
		return gateway.shards;
	}

	/**
	 * Get the gateway endpoint to connect to.
	 * @since 0.1.4
	 * @returns String url with the Gateway Endpoint to connect to.
	 */
	public async getGateway(): Promise<string> {
		const gatewayData = await this._restClient.bot.getGateway();
		return gatewayData.url;
	}

	/**
	 * Get the GatewayData including recommended amount of shards and other helpful info.
	 * @since 0.1.4
	 * @returns Object with url and shards to use to connect to discord.
	 */
	public async getGatewayBot(): Promise<APIGatewayBotInfo> {
		return this._restClient.bot.getGatewayBot();
	}

	/**
	 * Disconnect the bot gracefully,
	 * you will receive a 'disconnected' event once the ShardManager successfully closes all shard websocket connections.
	 * @since 0.1.4
	 * @param resumable Whether to close with a code that keeps the sessions alive on Discord's end, so another
	 * process can resume them via getResumeData() and the resumeData client option. The default close destroys them.
	 */
	public disconnect(resumable = false): void {
		return this.shardManager.disconnect(resumable);
	}

	/**
	 * Collect everything needed to resume all shards' sessions after a process restart, keyed by shard id.
	 * Resuming doesn't count against the daily identify limit and replays the events missed while disconnected.
	 *
	 * Take the snapshot AFTER disconnecting with client.disconnect(true) - a regular disconnect destroys the sessions,
	 * and a snapshot taken while still connected can go stale as more events arrive if they get processed.
	 * Shards whose sessions Discord no longer accepts fall back to identifying automatically.
	 * The returned object is JSON-serializable as-is.
	 * @since 0.19.0
	 *
	 * @example
	 * // Before shutting down:
	 * client.once("disconnected", () => {
	 * 	fs.writeFileSync("./resume.json", JSON.stringify(client.getResumeData()));
	 * 	process.exit(0);
	 * });
	 * client.disconnect(true);
	 *
	 * // After restarting:
	 * const client = new CloudStorm.Client(token, { resumeData: JSON.parse(fs.readFileSync("./resume.json", "utf8")) });
	 * client.connect();
	 */
	public getResumeData(): Record<number, IShardResumeData> {
		return this.shardManager.getResumeData();
	}

	/**
	 * Send an OP 3 PRESENCE_UPDATE to Discord, which updates the status of all shards facilitated by this client's ShardManager.
	 * @since 0.3.0
	 * @returns Promise that's resolved once all shards have sent the websocket payload.
	 *
	 * @example
	 * // Connect to Discord and set status to do not disturb and activity to "Memes are Dreams".
	 * const CloudStorm = require("cloudstorm"); // CloudStorm also supports import statements.
	 * const token = "token";
	 * const client = new CloudStorm.Client(token);
	 * client.connect();
	 * client.once("ready", () => {
	 * 	// Client is connected to Discord and is ready, so we can update the status.
	 * 	client.presenceUpdate({ status: "dnd", activities: [{ name: "Memes are Dreams", type: 0 }] });
	 * });
	 */
	public async presenceUpdate(data: Parameters<Client["shardManager"]["presenceUpdate"]>["0"]): Promise<void> {
		return this.shardManager.presenceUpdate(data);
	}

	/**
	 * Send an OP 3 PRESENCE_UPDATE to Discord, which updates the status of a single shard facilitated by this client's ShardManager.
	 * @since 0.11.0
	 * @param shardId id of the shard that should update it's status.
	 * @param data Presence data to send.
	 * @returns Promise that's resolved once the shard has sent the websocket payload.
	 *
	 * @example
	 * // Connect to Discord and set status to do not disturb and activity to "I'm shard 0".
	 * const CloudStorm = require("cloudstorm"); // CloudStorm also supports import statements.
	 * const token = "token";
	 * const client = new CloudStorm.Client(token);
	 * client.connect();
	 * client.once("ready", () => {
	 * 	// Client is connected to Discord and is ready, so we can update the status of shard 0.
	 * 	client.shardPresenceUpdate(0, { status: "dnd", activities: [{ name: "I'm shard 0", type: 0 }] });
	 * });
	 */
	public shardPresenceUpdate(shardId: number, data: Parameters<Client["shardManager"]["shardPresenceUpdate"]>["1"]): Promise<void> {
		return this.shardManager.shardPresenceUpdate(shardId, data);
	}

	/**
	 * Send an OP 4 VOICE_STATE_UPDATE to Discord. this does **not** allow you to send audio with CloudStorm itself,
	 * it just provides the necessary data for another application to send audio data to Discord.
	 * @since 0.1.4
	 * @param shardId id of the shard that should send the payload.
	 * @param data Voice state update data to send.
	 * @returns Promise that's resolved once the payload was sent to Discord.
	 *
	 * @example
	 * // Connect to Discord and join a voice channel
	 * const CloudStorm = require("cloudstorm"); // CloudStorm also supports import statements.
	 * const token = "token";
	 * const client = new CloudStorm.Client(token);
	 * client.connect();
	 * client.once("ready", () => {
	 * 	// Client is connected to Discord and is ready, so we can join a voice channel.
	 * 	// We will use shard 0 as the shard to send the payload.
	 * 	client.voiceStateUpdate(0, { guild_id: "id", channel_id: "id", self_mute: false, self_deaf: false });
	 * });
	 */
	public voiceStateUpdate(shardId: number, data: Parameters<Client["shardManager"]["voiceStateUpdate"]>["1"]): Promise<void> {
		return this.shardManager.voiceStateUpdate(shardId, data);
	}

	/**
	 * Send an OP 8 REQUEST_GUILD_MEMBERS to Discord.
	 * @since 0.1.4
	 * @param shardId id of the shard that should send the payload.
	 * @param data Request guild members data to send.
	 * @returns Promise that's resolved once the payload was send to Discord.
	 *
	 * @example
	 * // Connect to Discord and request guild members.
	 * const CloudStorm = require("cloudstorm"); // CloudStorm also supports import statements.
	 * const token = "token";
	 * const client = new CloudStorm.Client(token);
	 * client.connect();
	 * client.once("ready", () => {
	 * 	// Client is connected to Discord and is ready, so we can send the request guild members payload.
	 * 	// We will use shard 0 as the shard to send the payload.
	 * 	client.requestGuildMembers(0, { guild_id: "id" });
	 * });
	 */
	public async requestGuildMembers(shardId: number, data: Parameters<Client["shardManager"]["requestGuildMembers"]>["1"]): Promise<void> {
		return this.shardManager.requestGuildMembers(shardId, data);
	}

	/**
	 * Send an OP 31 REQUEST_SOUNDBOARD_SOUNDS to Discord.
	 * @param shardId id of the shard that should send the payload.
	 * @param guilds Guild ids to request soundboard sounds from.
	 * @returns Promise that's resolved once the payload was send to Discord.
	 *
	 * @example
	 * // Connect to Discord and request soundboard sounds.
	 * const CloudStorm = require("cloudstorm"); // CloudStorm also supports import statements.
	 * const token = "token";
	 * const client = new CloudStorm.Client(token);
	 * client.connect();
	 * client.once("ready", () => {
	 * 	// Client is connected to Discord and is ready, so we can send the request soundboard sounds payload.
	 * 	// We will use shard 0 as the shard to send the payload.
	 * 	client.requestSoundboardSounds(0, ["id"]);
	 * });
	 */
	public async requestSoundboardSounds(shardId: number, guilds: Parameters<Client["shardManager"]["requestSoundboardSounds"]>["1"]): Promise<void> {
		return this.shardManager.requestSoundboardSounds(shardId, guilds);
	}

	/**
	 * Send an OP 43 REQUEST_CHANNEL_INFO to Discord.
	 * @param shardId id of the shard that should send the payload.
	 * @param data Request channel info data to send.
	 * @returns Promise that's resolved once the payload was send to Discord.
	 *
	 * @example
	 * // Connect to Discord and request channel info.
	 * const CloudStorm = require("cloudstorm"); // CloudStorm also supports import statements.
	 * const token = "token";
	 * const client = new CloudStorm.Client(token);
	 * client.connect();
	 * client.once("ready", () => {
	 * 	// Client is connected to Discord and is ready, so we can send the request channel info payload.
	 * 	// We will use shard 0 as the shard to send the payload.
	 * 	client.requestChannelInfo(0, ["id"]);
	 * });
	 */
	public async requestChannelInfo(shardId: number, data: Parameters<Client["shardManager"]["requestChannelInfo"]>["1"]): Promise<void> {
		return this.shardManager.requestChannelInfo(shardId, data);
	}

	/**
	 * Update the endpoint shard websockets will connect to.
	 * @since 0.1.4
	 * @param gatewayUrl Base gateway wss url to update the cached endpoint to.
	 */
	private _updateEndpoint(gatewayUrl: string): void {
		this.options.endpoint = Constants.getGatewayAddress(gatewayUrl, this.options.ws);
	}
}

export = Client;
