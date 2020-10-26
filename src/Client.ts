"use strict";

const version = require("../package.json").version;
import { EventEmitter } from "events";
let Erlpack: typeof import("erlpack");
try {
	Erlpack = require("erlpack");
// eslint-disable-next-line no-empty
} catch (e) {}
import Constants from "./Constants";
import SnowTransfer from "snowtransfer";
import ShardManager from "./ShardManager";

interface ClientEvents {
	debug: [string];
	rawSend: [import("./Types").IWSMessage];
	rawReceive: [import("./Types").IGatewayMessage];
	event: [import("./Types").IGatewayMessage];
	dispatch: [import("./Types").IGatewayMessage];
	voiceStateUpdate: [import("./Types").IGatewayMessage];
	shardReady: [{ id: number; ready: boolean; }];
	error: [string];
	ready: [];
	disconnected: [];
}

/**
 * Main class used for receiving events and interacting with the discord gateway
 */
class Client extends EventEmitter {
	public token: string;
	public options: import("./Types").IClientOptions & { token: string; endpoint?: string; };
	public shardManager: ShardManager;
	public version: any;
	private _restClient: SnowTransfer;

	/**
	 * Create a new Client to connect to the gateway
	 * @param token token received from creating a discord bot user, which will be used to connect to the gateway
	 */
	public constructor(token: string, options: import("./Types").IClientOptions = {}) {
		super();
		if (!token) {
			throw new Error("Missing token!");
		}
		this.options = {
			largeGuildThreshold: 250,
			firstShardId: 0,
			lastShardId: 0,
			shardAmount: 1,
			reconnect: true,
			intents: 0,
			token: ""
		};
		this.token = token.startsWith("Bot ") ? token.substring(4) : token;
		Object.assign(this.options, options);
		this.options.token = token;
		this.shardManager = new ShardManager(this);
		this.version = version;
		this._restClient = new SnowTransfer(token);
	}

	public emit<E extends keyof ClientEvents>(event: E, ...args: ClientEvents[E]) {
		return super.emit(event, args);
	}
	public once<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => any) {
		// @ts-ignore SHUT UP!!!
		return super.once(event, listener);
	}
	public on<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => any) {
		// @ts-ignore
		return super.on(event, listener);
	}

	public static get Constants() {
		return Constants;
	}

	/**
	 * Create one or more connections (depending on the selected amount of shards) to the discord gateway
	 * @returns This function returns a promise which is solely used for awaiting the getGateway() method's return value
	 */
	public async connect(): Promise<void> {
		const gatewayUrl = await this.getGateway();
		this._updateEndpoint(gatewayUrl);
		this.shardManager.spawn();
	}

	/**
	 * Get the gateway endpoint to connect to
	 * @returns String url with the Gateway Endpoint to connect to
	 */
	public async getGateway(): Promise<string> {
		const gatewayData = await this._restClient.bot.getGateway();
		return gatewayData.url;
	}

	/**
	 * Get the GatewayData including recommended amount of shards
	 * @returns Object with url and shards to use to connect to discord
	 */
	public async getGatewayBot(): Promise<any> {
		return this._restClient.bot.getGatewayBot();
	}

	/**
	 * Disconnect the bot gracefully,
	 * you will receive a 'disconnected' Event once the bot successfully shutdown
	 */
	public disconnect() {
		return this.shardManager.disconnect();
	}

	/**
	 * Send a status update to discord, which updates the status of all shards
	 * @returns Promise that's resolved once all shards have sent the websocket payload
	 *
	 * @example
	 * //Connect bot to discord and set status to do not disturb and game to "Memes are Dreams"
	 * let bot = new CloudStorm(token)
	 * await bot.connect()
	 * bot.on('ready', () => {
	 *   // Bot is connected to discord and ready so we can update the status
	 *   bot.statusUpdate({status:'dnd', game:{name:'Memes are Dreams'}})
	 * });
	 */
	public async statusUpdate(data: import("./Types").IPresence): Promise<void> {
		await this.shardManager.statusUpdate(data);
		void undefined;
	}

	/**
	 * Send a status update to discord, which updates the status of a single shard
	 * @param shardId Id of the shard that should update it's status
	 * @param data
	 * @returns Promise that's resolved once the shard has sent the websocket payload
	 *
	 * @example
	 * //Connect bot to discord and set status to do not disturb and game to "Im shard 0"
	 * let bot = new CloudStorm(token)
	 * await bot.connect()
	 * bot.on('ready', () => {
	 *   // Bot is connected to discord and ready so we can update the status of shard 0
	 *   bot.shardStatusUpdate(0, {status:'dnd', game:{name:'Im shard 0'}})
	 * });
	 */
	public shardStatusUpdate(shardId: number, data: import("./Types").IPresence): Promise<void> {
		return this.shardManager.shardStatusUpdate(shardId, data);
	}

	/**
	 * Send a voice state update to discord, this does **not** allow you to send audio with cloudstorm itself,
	 * it just provides the necessary data for another application to send audio data to discord
	 * @param shardId id of the shard that should send the payload
	 * @param data voice state update data to send
	 * @returns Promise that's resolved once the payload was sent to discord
	 *
	 * @example
	 * //Connect bot to discord and join a voice channel
	 * let bot = new CloudStorm(token)
	 * await bot.connect()
	 * bot.on('ready', () => {
	 *   // Bot is connected to discord and ready so we can join a voice channel
	 *   // We will use shard 0 as the shard to send the payload
	 *   bot.voiceStateUpdate(0, {guild_id:'id', channel_id:'id', self_mute:false, self_deaf:false})
	 * });
	 */
	public voiceStateUpdate(shardId: number, data: import("./Types").IVoiceStateUpdate): Promise<void> {
		return this.shardManager.voiceStateUpdate(shardId, data);
	}

	/**
	 * Send a request guild members update to discord
	 * @param shardId id of the shard that should send the payload
	 * @param data
	 * @returns Promise that's resolved once the payload was send to discord
	 *
	 * @example
	 * //Connect bot to discord and set status to do not disturb and game to "Memes are Dreams"
	 * let bot = new CloudStorm(token)
	 * await bot.connect()
	 * bot.on('ready', () => {
	 *   // Bot is connected to discord and ready so we can send the request guild members payload
	 *   // We will use shard 0 as the shard to send the payload
	 *   bot.requestGuildMembers(0, {guild_id:'id'})
	 * });
	 */
	public requestGuildMembers(shardId: number, data: import("./Types").IRequestGuildMembers): Promise<void> {
		if (!data.guild_id) {
			throw new Error("You need to pass a guild_id");
		}
		return this.shardManager.requestGuildMembers(shardId, data);
	}

	private _updateEndpoint(gatewayUrl: string) {
		this.options.endpoint = `${gatewayUrl}?v=${Constants.GATEWAY_VERSION}&encoding=${Erlpack ? "etf" : "json"}&compress=zlib-stream`;
	}
}

export = Client;
