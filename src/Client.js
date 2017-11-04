'use strict';
let version = require('../package.json').version;
let EventEmitter;
try {
    EventEmitter = require('eventemitter3');
} catch (e) {
    EventEmitter = require('events').EventEmitter;
}
let Erlpack;
try {
    Erlpack = require('erlpack');
// eslint-disable-next-line no-empty
} catch (e) {

}
const Constants = require('./Constants');
const SnowTransfer = require('snowtransfer');
const ShardManager = require('./ShardManager');

/**
 * Main class used for receiving events and interacting with the discord gateway
 * @property {ShardManager} shardManager - shard manager used for managing a pool of shards (connections) to the discord gateway, discord requires you to shard your bot at 2500 guilds,
 * but you may do it earlier.
 * @property {String} version - version of this package, exposed so you can use it easier.
 * @extends {EventEmitter} EventEmitter
 */
class Client extends EventEmitter {
    /**
     * Create a new Client to connect to the gateway
     * @param {String} token - token received from creating a discord bot user, which will be used to connect to the gateway
     * @param {Object} [options]
     * @param {Number} [options.large_guild_threshold=250] - Value between 50 and 250 at which the discord gateway stops sending offline guild members
     * @param {Number} [options.firstShardId=0] - Id of the first shard that should be started
     * @param {Number} [options.lastShardId=0] - Id of the last shard that should be started, not to be confused with shardAmount, lastShardId tells CloudStorm the range of shardId's to spawn,
     * so you can use this parameter to run multi-process sharding where one CloudStorm instance running multiple shards runs in one process.
     * Set it to shardAmount-1 if you are unsure about what it does.
     * @param {Number} [options.shardAmount=1] - Amount of **total** shards connecting to discord
     * @param {Boolean} [options.reconnect=true] - If the bot should automatically reconnect to discord if it get's disconnected, **leave it set to true unless you know what you are doing**
     * @param {Presence} [options.initialPresence] - If you want to start the bot with an initial presence, you may set it here
     */
    constructor(token, options = {}) {
        super();
        if (!token) {
            throw new Error('Missing token!');
        }
        this.options = {
            large_guild_threshold: 250,
            firstShardId: 0,
            lastShardId: 0,
            shardAmount: 1,
            reconnect: true
        };
        this.token = token.startsWith('Bot ') ? token.substring(4) : token;
        Object.assign(this.options, options);
        this.options.token = token;
        this.shardManager = new ShardManager(this);
        this.version = version;
        this._restClient = new SnowTransfer(token);
    }

    /**
     * Connect the bot to the gateway
     */
    async connect() {
        let gatewayUrl = await this.getGateway();
        this._updateEndpoint(gatewayUrl);
        this.shardManager.spawn();
    }

    /**
     * Get the gateway endpoint to connect to
     * @returns {Promise.<String>} - endpoint to connect to
     */
    async getGateway() {
        let gatewayData = await this._restClient.bot.getGateway();
        return gatewayData.url;
    }

    /**
     * Get the GatewayData including recommended amount of shards
     * @returns {Promise.<GatewayData>} - Object with url and shards to use to connect to discord
     */
    async getGatewayBot() {
        return this._restClient.bot.getGatewayBot();
    }

    /**
     * Disconnect the bot gracefully
     * @returns {Promise.<void>}
     */
    async disconnect() {
        return this.shardManager.disconnect();
    }

    /**
     * Send a status update to discord, which updates the status of all shards
     * @param {Presence} data - presence data to send
     */
    statusUpdate(data) {
        this.shardManager.statusUpdate(data);
    }

    /**
     * Send a voice state update to discord
     * @param {String} shardId - id of the shard that should send the payload
     * @param {VoiceStateUpdate} data - voice state update data to send
     */
    voiceStateUpdate(shardId, data) {
        this.shardManager.voiceStateUpdate(shardId, data);
    }

    /**
     * Send a request guild members update to discord
     * @param {String} shardId - id of the shard that should send the payload
     * @param {RequestGuildMembers} data - request guild members data to send
     */
    requestGuildMembers(shardId, data) {
        if (!data.guild_id) {
            throw new Error('You need to pass a guild_id');
        }
        this.shardManager.requestGuildMembers(shardId, data);
    }

    _updateEndpoint(gatewayUrl) {
        this.options.endpoint = `${gatewayUrl}?v=${Constants.GATEWAY_VERSION}&encoding=${Erlpack ? 'etf' : 'json'}&compress=zlib-stream`;
    }
}

/**
 * @typedef {Object} RequestGuildMembers
 * @property {String} guild_id - id of the guild
 * @property {String} query - string that the username starts with or empty to match all members
 * @property {Number} limit - limit of members that should be returned or 0 to return all
 */

/**
 * @typedef {Object} VoiceStateUpdate
 * @property {String} guild_id - id of the guild
 * @property {String|null} channel_id - id of the channel to join or null if leaving channel
 * @property {Boolean} self_mute - if the client is muted
 * @property {Boolean} self_deaf - if the client is deafened
 */

/**
 * @typedef {Object} Presence - Presence on a server, contains online status and game (if any)
 * @property {String} status - Status of the bot, use one of the [status types](https://discordapp.com/developers/docs/topics/gateway#gateway-status-update-status-types)
 * @property {Game} game - Game to set
 */

/**
 * @typedef {Object} Game
 * @property {String} name - name of the game
 * @property {Number} [type=0] - type of the game, see [game types](https://discordapp.com/developers/docs/topics/gateway#gateway-status-update-status-types)
 * @property {String} [url] - url of the game, used when streaming in combination with type 1 to provide a link to the account of streamer, **only https://twitch.tv is supported atm**
 */

module.exports = Client;
