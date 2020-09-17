"use strict";
let version = require("../package.json").version;
const { EventEmitter } = require("events");
let Erlpack;
try {
	Erlpack = require("erlpack");
// eslint-disable-next-line no-empty
} catch (e) {

}
const Constants = require("./Constants");
const SnowTransfer = require("snowtransfer");
const ShardManager = require("./ShardManager");

/**
 * Main class used for receiving events and interacting with the discord gateway
 */
class Client extends EventEmitter {
	/**
	 * Create a new Client to connect to the gateway
	 * @param {string} token - token received from creating a discord bot user, which will be used to connect to the gateway
	 * @param {Object} [options]
	 * @param {number} [options.largeGuildThreshold=250] - Value between 50 and 250 at which the discord gateway stops sending offline guild members
	 * @param {number} [options.firstShardId=0] - Id of the first shard that should be started
	 * @param {number} [options.lastShardId=0] - Id of the last shard that should be started, not to be confused with shardAmount, lastShardId tells CloudStorm the range of shardId's to spawn,
	 * so you can use this parameter to run multi-process sharding where one CloudStorm instance running multiple shards runs in one process.
	 * Set it to shardAmount-1 if you are unsure about what it does.
	 * @param {number} [options.shardAmount=1] - Amount of **total** shards connecting to discord
	 * @param {boolean} [options.reconnect=true] - If the bot should automatically reconnect to discord if it get's disconnected, **leave it set to true unless you know what you are doing**
	 * @param {import("../typings").IPresence} [options.initialPresence] - If you want to start the bot with an initial presence, you may set it here
	 * @param {import("./Intents").IntentResolvable} [options.intents] If you want to pass Gateway Intents.
	 * @property {ShardManager} shardManager - shard manager used for managing a pool of shards (connections) to the discord gateway, discord requires you to shard your bot at 2500 guilds,
	 * but you may do it earlier.
	 * @property {string} version - version of this package, exposed so you can use it easier.
	 * @constructor
	 */
	constructor(token, options = {}) {
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
			intents: 0
		};
		this.token = token.startsWith("Bot ") ? token.substring(4) : token;
		Object.assign(this.options, options);
		this.options.token = token;
		this.shardManager = new ShardManager(this);
		this.version = version;
		this._restClient = new SnowTransfer(token);
	}

	/**
	 * Create one or more connections (depending on the selected amount of shards) to the discord gateway
	 * @returns {Promise<void>} This function returns a promise which is solely used for awaiting the getGateway() method's return value
	 */
	async connect() {
		let gatewayUrl = await this.getGateway();
		this._updateEndpoint(gatewayUrl);
		this.shardManager.spawn();
	}

	/**
	 * Get the gateway endpoint to connect to
	 * @returns {Promise<string>} String url with the Gateway Endpoint to connect to
	 */
	async getGateway() {
		let gatewayData = await this._restClient.bot.getGateway();
		return gatewayData.url;
	}

	/**
	 * Get the GatewayData including recommended amount of shards
	 * @returns {Promise<any>} Object with url and shards to use to connect to discord
	 */
	async getGatewayBot() {
		return this._restClient.bot.getGatewayBot();
	}

	/**
	 * Disconnect the bot gracefully,
	 * you will receive a 'disconnected' Event once the bot successfully shutdown
	 */
	disconnect() {
		return this.shardManager.disconnect();
	}

	/**
	 * Send a status update to discord, which updates the status of all shards
	 * @param {import("../typings").IPresence} data
	 * @returns {Promise<void>} Promise that's resolved once all shards have sent the websocket payload
	 * @example
	 * //Connect bot to discord and set status to do not disturb and game to "Memes are Dreams"
	 * let bot = new CloudStorm(token)
	 * await bot.connect()
	 * bot.on('ready', () => {
	 *   // Bot is connected to discord and ready so we can update the status
	 *   bot.statusUpdate({status:'dnd', game:{name:'Memes are Dreams'}})
	 * });
	 */
	async statusUpdate(data) {
		await this.shardManager.statusUpdate(data);
		void undefined;
	}

	/**
	 * Send a status update to discord, which updates the status of a single shard
	 * @param {number} shardId Id of the shard that should update it's status
	 * @param {import("../typings").IPresence} data
	 * @returns {Promise<void>} Promise that's resolved once the shard has sent the websocket payload
	 * @example
	 * //Connect bot to discord and set status to do not disturb and game to "Im shard 0"
	 * let bot = new CloudStorm(token)
	 * await bot.connect()
	 * bot.on('ready', () => {
	 *   // Bot is connected to discord and ready so we can update the status of shard 0
	 *   bot.shardStatusUpdate(0, {status:'dnd', game:{name:'Im shard 0'}})
	 * });
	 */
	shardStatusUpdate(shardId, data) {
		return this.shardManager.shardStatusUpdate(shardId, data);
	}

	/**
	 * Send a voice state update to discord, this does **not** allow you to send audio with cloudstorm itself,
	 * it just provides the necessary data for another application to send audio data to discord
	 * @param {number} shardId - id of the shard that should send the payload
	 * @param {Object} data - voice state update data to send
	 * @param {string} data.guild_id - id of the guild where the channel exists
	 * @param {string|null} data.channel_id - id of the channel to join or null if leaving channel
	 * @param {boolean} data.self_mute - if the client is muted
	 * @param {boolean} data.self_deaf - if the client is deafened
	 * @returns {Promise<void>} - Promise that's resolved once the payload was sent to discord
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
	voiceStateUpdate(shardId, data) {
		return this.shardManager.voiceStateUpdate(shardId, data);
	}

	/**
	 * Send a request guild members update to discord
	 * @param {number} shardId - id of the shard that should send the payload
	 * @param {import("../typings").IRequestGuildMembers} data
	 * @returns {Promise.<void>} - Promise that's resolved once the payload was send to discord
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
	requestGuildMembers(shardId, data) {
		if (!data.guild_id) {
			throw new Error("You need to pass a guild_id");
		}
		return this.shardManager.requestGuildMembers(shardId, data);
	}

	_updateEndpoint(gatewayUrl) {
		this.options.endpoint = `${gatewayUrl}?v=${Constants.GATEWAY_VERSION}&encoding=${Erlpack ? "etf" : "json"}&compress=zlib-stream`;
	}
}

module.exports = Client;
