"use strict";

const version = require("../package.json").version as string;
import { EventEmitter } from "events";
import Constants = require("./Constants");
import { SnowTransfer, LocalBucket } from "snowtransfer";
import ShardManager = require("./ShardManager");
import type {
	GatewaySendPayload,
	GatewayReceivePayload,
	APIGatewayBotInfo
} from "discord-api-types/v10";

interface ClientEvents {
	debug: [string];
	rawSend: [GatewaySendPayload];
	rawReceive: [GatewayReceivePayload];
	error: [string]; // no processing messages

	event: [import("./Types").IGatewayMessage];
	dispatch: [import("./Types").IGatewayDispatch];
	shardReady: [{ id: number; ready: boolean; }];
	ready: [];
	disconnected: [];
}

interface Client {
	addListener<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => any): this;
	emit<E extends keyof ClientEvents>(event: E, ...args: ClientEvents[E]): boolean;
	eventNames(): Array<keyof ClientEvents>;
	listenerCount(event: keyof ClientEvents): number;
	listeners(event: keyof ClientEvents): Array<(...args: Array<any>) => any>;
	off<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => any): this;
	on<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => any): this;
	once<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => any): this;
	prependListener<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => any): this;
	prependOnceListener<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => any): this;
	rawListeners(event: keyof ClientEvents): Array<(...args: Array<any>) => any>;
	removeAllListeners(event?: keyof ClientEvents): this;
	removeListener<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => any): this;
}

/**
 * Main class used for receiving events and interacting with the Discord gateway.
 */
class Client extends EventEmitter {
	/** The Discord auth token to connect with. */
	public token: string;
	/** User specific options filled in with defaults if not specified. */
	public options: Omit<import("./Types").IClientOptions, "snowtransferInstance"> & { token: string; endpoint?: string; };
	/** The manager of all of the shards used to connect to Discord. */
	public shardManager: ShardManager;
	/** The version string of CloudStorm. */
	public version = version;
	/** The SnowTransfer instance to use to make some requests to get connect info. */
	private _restClient: SnowTransfer;

	/**
	 * Create a new Client to connect to the Discord gateway.
	 * @param token Token received from creating a discord bot user, which will be used to connect to the gateway.
	 * @param options Baseline options to use. Will be filled with defaults if not specified.
	 */
	public constructor(token: string, options: import("./Types").IClientOptions = {}) {
		super();
		if (!token) throw new Error("Missing token!");
		this.options = {
			largeGuildThreshold: 250,
			shards: "auto",
			reconnect: true,
			intents: 0,
			token: "",
			ws: {
				compress: true,
				encoding: "json"
			}
		};
		this._restClient = options.snowtransferInstance ? options.snowtransferInstance : new SnowTransfer(token);
		delete options.snowtransferInstance;
		this.token = token.startsWith("Bot ") ? token.substring(4) : token;
		Object.assign(this.options, options);
		this.options.token = token;
		this.shardManager = new ShardManager(this);
	}

	/**
	 * Create one or more connections (depending on the selected amount of shards) to the Discord gateway.
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
	 * @returns The amount of shards the bot should spawn if set to auto.
	 */
	public async fetchConnectInfo(): Promise<number> {
		const gateway = await this.getGatewayBot();
		this._updateEndpoint(gateway.url);
		const oldQueueConcurrency = [] as Array<() => unknown>;
		const oldQueueIdentify = [] as Array<() => unknown>;
		if (this.shardManager.concurrencyBucket?.fnQueue.length) {
			oldQueueConcurrency.push(...this.shardManager.concurrencyBucket.fnQueue);
			this.shardManager.concurrencyBucket.dropQueue();
		}
		if (this.shardManager.identifyBucket.fnQueue.length) oldQueueIdentify.push(...this.shardManager.identifyBucket.fnQueue);
		this.shardManager.identifyBucket.dropQueue();
		this.shardManager.concurrencyBucket = new LocalBucket(gateway.session_start_limit.max_concurrency, 5000);
		this.shardManager.identifyBucket.remaining = gateway.session_start_limit.remaining;
		this.shardManager.identifyBucket.reset = gateway.session_start_limit.reset_after;
		for (const fn of oldQueueConcurrency) {
			this.shardManager.concurrencyBucket.queue(fn);
		}
		for (const fn of oldQueueIdentify) {
			this.shardManager.identifyBucket.queue(fn);
		}
		return gateway.shards;
	}

	/**
	 * Get the gateway endpoint to connect to.
	 * @returns String url with the Gateway Endpoint to connect to.
	 */
	public async getGateway(): Promise<string> {
		const gatewayData = await this._restClient.bot.getGateway();
		return gatewayData.url;
	}

	/**
	 * Get the GatewayData including recommended amount of shards and other helpful info.
	 * @returns Object with url and shards to use to connect to discord.
	 */
	public async getGatewayBot(): Promise<APIGatewayBotInfo> {
		return this._restClient.bot.getGatewayBot();
	}

	/**
	 * Disconnect the bot gracefully,
	 * you will receive a 'disconnected' event once the ShardManager successfully closes all shard websocket connections.
	 */
	public disconnect(): void {
		return this.shardManager.disconnect();
	}

	/**
	 * Send an OP 3 PRESENCE_UPDATE to Discord, which updates the status of all shards facilitated by this client's ShardManager.
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
	 * @param shardId id of the shard that should update it's status.
	 * @param data Presence data to send.
	 * @returns Promise that's resolved once the shard has sent the websocket payload.
	 *
	 * @example
	 * // Connect to Discord and set status to do not disturb and activity to "Im shard 0".
	 * const CloudStorm = require("cloudstorm"); // CloudStorm also supports import statements.
	 * const token = "token";
	 * const client = new CloudStorm.Client(token);
	 * client.connect();
	 * client.once("ready", () => {
	 * 	// Client is connected to Discord and is ready, so we can update the status of shard 0.
	 * 	client.shardPresenceUpdate(0, { status: "dnd", activities: [{ name: "Im shard 0", type: 0 }] });
	 * });
	 */
	public shardStatusUpdate(shardId: number, data: Parameters<Client["shardManager"]["shardPresenceUpdate"]>["1"]): Promise<void> {
		return this.shardManager.shardPresenceUpdate(shardId, data);
	}

	/**
	 * Send an OP 4 VOICE_STATE_UPDATE to Discord. this does **not** allow you to send audio with CloudStorm itself,
	 * it just provides the necessary data for another application to send audio data to Discord.
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
	public requestGuildMembers(shardId: number, data: Parameters<Client["shardManager"]["requestGuildMembers"]>["1"]): Promise<void> {
		if (!data.guild_id) throw new Error("You need to pass a guild_id");
		return this.shardManager.requestGuildMembers(shardId, data);
	}

	/**
	 * Update the endpoint shard websockets will connect to.
	 * @param gatewayUrl Base gateway wss url to update the cached endpoint to.
	 */
	private _updateEndpoint(gatewayUrl: string): void {
		this.options.endpoint = `${gatewayUrl}?v=${Constants.GATEWAY_VERSION}&encoding=${this.options.ws?.encoding === "etf" ? "etf" : "json"}${this.options.ws?.compress ? "&compress=zlib-stream" : ""}`;
	}
}

export = Client;
