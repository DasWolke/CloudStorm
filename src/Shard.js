'use strict';
let EventEmitter;
try {
    EventEmitter = require('eventemitter3');
} catch (e) {
    EventEmitter = require('events').EventEmitter;
}
const DiscordConnector = require('./connector/DiscordConnector');
const OP_CODES = require('./Constants').GATEWAY_OP_CODES;

/**
 * @typedef Shard
 * @description Shard class, which provides a wrapper around the DiscordConnector with metadata like the id of the shard
 *
 * This class is automatically instantiated by the library and is documented for reference
 * @property {Number} id - Id of the shard
 * @property {Client} client - main class used for forwarding events
 * @property {Boolean} forceIdentify - whether the connector should not try to resume and re-identify
 * @property {Boolean} ready - if this shard has successfully connected and identified with the gateway
 * @property {DiscordConnector} connector - connector used for connecting to discord
 */
class Shard extends EventEmitter {
    /**
     * Create a new Shard
     * @param {Number} id - Id of the shard
     * @param {Client} client - main class used for forwarding events
     * @private
     */
    constructor(id, client) {
        super();
        this.id = id;
        this.client = client;
        this.forceIdentify = false;
        this.ready = false;
        this.connector = new DiscordConnector(id, client);
        this.connector.on('event', (event) => {
            event.shard_id = this.id;
            /**
             * @event Client#event
             * @type {Object}
             * @description Emitted when an event is received from discord, this event is a raw discord event.
             *
             * Packets that are guaranteed to be emitted to you are OP 0 (DISPATCH) and OP 4 (VOICE STATE UPDATE)
             *
             * **Other OPs may be catched by the library and used for internal processing, so you should not count on them**
             * @example
             * //Connect bot to discord and listen for received events
             * let bot = new CloudStorm(token)
             * await bot.connect()
             * bot.on('event', (event) => {
             *   // Do something with the event
             * });
             */
            this.client.emit('event', event);
            switch (event.op) {
                case OP_CODES.DISPATCH:
                    /**
                     * @event Client#dispatch
                     * @type {Object}
                     * @description Emitted when a OP **dispatch** event is received by the bot
                     *
                     * Dispatch events are usual events that happen on discord like message_create, presence_update, etc..
                     */
                    this.client.emit('dispatch', event);
                    break;
                case OP_CODES.VOICE_STATE_UPDATE:
                    /**
                     * @event Client#voiceStateUpdate
                     * @type {Object}
                     * @description Emitted when a OP **voice state update** event is received by the bot
                     * @property {String} guild_id - id of the guild
                     * @property {String|null} channel_id - id of the channel that was joined or null if the user is leaving the channel
                     * @property {Boolean} self_mute - if the user is muted
                     * @property {Boolean} self_deaf - if the user is deafened
                     */
                    this.client.emit('voiceStateUpdate', event);
                    break;
                default:
                    break;
            }
        });
        this.connector.on('disconnect', (...args) => {
            this.ready = false;
            /**
             * @event Shard#disconnect
             * @type {void}
             * @description Emitted when the shard get's disconnected from the gateway
             * @private
             */
            this.emit('disconnect', ...args);
        });
        this.connector.on('error', (err) => {
            /**
             * @event Shard#error
             * @type {Error}
             * @description Emitted when the shard (or internal components of it) error
             * @private
             */
            this.emit('error', err);
        });
        this.connector.on('ready', () => {
            /**
             * @event Shard#ready
             * @type {void}
             * @description Emitted when the shard turns ready
             * @private
             */
            this.emit('ready');
        });
    }

    /**
     * Create a new Connection to discord
     * @protected
     */
    connect() {
        if (this.forceIdentify) {
            this.connector.forceIdentify = true;
            this.forceIdentify = false;
        }
        this.connector.connect();
    }

    /**
     * Close the current connection
     * @returns {Promise.<void>}
     * @protected
     */
    disconnect() {
        return this.connector.disconnect();
    }

    /**
     * Send a status update payload to discord
     * @param {Presence} data - data to send
     * @returns {Promise.<void>}
     * @protected
     */
    statusUpdate(data) {
        return this.connector.statusUpdate(data);
    }

    /**
     * Send a voice state update payload to discord
     * @param {VoiceStateUpdate} data - data to send
     * @returns {Promise.<void>}
     * @protected
     */
    voiceStateUpdate(data) {
        return this.connector.voiceStateUpdate(data);
    }

    /**
     * Send a request guild members payload to discord
     * @param {RequestGuildMembers} data - data to send
     * @returns {Promise.<void>}
     * @protected
     */
    requestGuildMembers(data) {
        return this.connector.requestGuildMembers(data);
    }

}

module.exports = Shard;
