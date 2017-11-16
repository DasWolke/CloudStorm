'use strict';
let EventEmitter;
try {
    EventEmitter = require('eventemitter3');
} catch (e) {
    EventEmitter = require('events').EventEmitter;
}
const BetterWs = require('../structures/BetterWs');
const OP = require('../Constants').GATEWAY_OP_CODES;

/**
 * @typedef DiscordConnector
 * @description Class used for acting based on received events
 *
 * This class is automatically instantiated by the library and is documented for reference
 * @property {String} id - id of the shard that created this class
 * @property {Client} client - Main client instance
 * @property {Object} options - options passed from the main client instance
 * @property {Boolean} reconnect - whether autoreconnect is enabled
 * @property {BetterWs} betterWs - Websocket class used for connecting to discord
 * @property {Object} heartbeatInterval - interval within which heartbeats should be sent to discord
 * @property {String[]} _trace - trace of servers used when connecting to discord
 * @property {Number} seq - sequence value used on RESUMES and heartbeats
 * @property {String} status - status of this connector
 * @property {String} sessionId - session id of the current session, used in RESUMES
 * @property {Boolean} forceIdentify - whether the connector should just IDENTIFY again and don't try to resume
 */
class DiscordConnector extends EventEmitter {
    /**
     * Create a new Discord Connector
     * @param {String} id - id of the shard that created this class
     * @param {Client} client - Main client instance
     * @private
     */
    constructor(id, client) {
        super();
        this.id = id;
        this.client = client;
        this.options = client.options;
        this.reconnect = this.options.reconnect;
        this.betterWs = null;
        this.heartbeatInterval = null;
        this._trace = null;
        this.seq = 0;
        this.status = 'init';
        this.sessionId = null;
        this.forceIdentify = false;
    }

    /**
     * Connect to discord
     * @protected
     */
    connect() {
        if (!this.betterWs) {
            this.betterWs = new BetterWs(this.options.endpoint);
        } else {
            this.betterWs.removeAllListeners();
            this.betterWs.recreateWs(this.options.endpoint);
        }
        this.betterWs.on('ws_open', () => {
            this.status = 'connecting';
        });
        this.betterWs.on('ws_message', (msg) => {
            this.messageAction(msg);
        });
        this.betterWs.on('ws_close', (code, reason) => {
            this.client.emit('debug', `Websocket of shard ${this.id} closed with code ${code} and reason: ${reason}`);
            this.handleWsClose(code, reason);
        });
        this.betterWs.on('debug', event => {
            /**
             * @event Client#debug
             * @type {Object}
             * @description Debug event used for debugging the library
             * @private
             */
            this.client.emit('debug', event);
        });
        this.betterWs.on('debug_send', data => {
            /**
             * @event Client#rawSend
             * @type {Object}
             * @description Websocket payload which was sent to discord, this event is emitted on **every single** websocket message that was sent.
             */
            this.client.emit('rawSend', data);
        });
    }

    /**
     * Close the websocket connection and disconnect
     * @returns {Promise.<void>}
     * @protected
     */
    disconnect() {
        return this.betterWs.close(1000, 'Disconnect from User');
    }

    /**
     * Called with a parsed Websocket message to execute further actions
     * @param {Object} message - message that was received
     * @protected
     */
    messageAction(message) {
        /**
         * @event Client#rawReceive
         * @type {Object}
         * @description Websocket message received from discord, this event is emitted on **every single** websocket message you may receive.
         */
        this.client.emit('rawReceive', message);
        switch (message.op) {
            case OP.DISPATCH:
                if (message.s) {
                    this.seq = message.s;
                }
                this.handleDispatch(message);
                break;
            case OP.HELLO:
                this.heartbeat();
                this.heartbeatInterval = setInterval(() => {
                    this.heartbeat();
                }, message.d.heartbeat_interval - 5000);
                this._trace = message.d._trace;
                this.identify();
                this.client.emit('debug', `Shard ${this.id} received HELLO`);
                break;
            case OP.HEARTBEAT_ACK:
                break;
            case OP.RECONNECT:
                this.reset();
                this.betterWs.close();
                break;
            case OP.INVALID_SESSION:
                if (message.d && this.sessionId) {
                    this.resume();
                } else {
                    this.identify(true);
                }
                break;
            default:
                /**
                 * @event DiscordConnector#event
                 * @type {Object}
                 * @description Forward the event
                 * @private
                 */
                this.emit('event', message);
        }
    }

    /**
     * Reset this connector
     * @protected
     */
    reset() {
        this.sessionId = null;
        this.seq = 0;
        this._trace = null;
        this.heartbeatInterval = null;
    }

    /**
     * Send a identify payload to the gateway
     * @param {Boolean} force - Whether CloudStorm should send an IDENTIFY even if there's a session that could be resumed
     * @returns {Promise.<void>}
     * @protected
     */
    identify(force) {
        if (this.sessionId && !this.forceIdentify && !force) {
            return this.resume();
        }
        let data = {
            op: OP.IDENTIFY, d: {
                token: this.options.token,
                properties: {
                    os: process.platform,
                    browser: 'CloudStorm',
                    device: 'CloudStorm'
                },
                large_threshold: this.options.largeGuildThreshold,
                shard: [this.id, this.options.shardAmount],
                presence: this.options.initialPresence ? this._checkPresenceData(this.options.initialPresence) : null
            }
        };
        this.forceIdentify = false;
        return this.betterWs.sendMessage(data);
    }

    /**
     * Send a resume payload to the gateway
     * @returns {Promise.<void>}
     * @protected
     */
    resume() {
        return this.betterWs.sendMessage({
            op: OP.RESUME,
            d: {seq: this.seq, token: this.options.token, session_id: this.sessionId}
        });
    }

    /**
     * Send a heartbeat to discord
     * @protected
     */
    heartbeat() {
        this.betterWs.sendMessage({op: OP.HEARTBEAT, d: this.seq});
    }

    /**
     * Handle dispatch events
     * @param {Object} message - message received from the websocket
     * @protected
     */
    handleDispatch(message) {
        switch (message.t) {
            case 'READY':
            case 'RESUMED':
                if (message.t === 'READY') {
                    this.sessionId = message.d.session_id;
                }
                this.status = 'ready';
                this._trace = message.d._trace;
                /**
                 * @event DiscordConnector#ready
                 * @type {void}
                 * @description Emitted once the connector is ready (again)
                 * @private
                 */
                this.emit('ready', message.t === 'RESUMED');
                /**
                 * @event DiscordConnector#event
                 * @type {Object}
                 * @description Emitted once an event was received from discord
                 * @private
                 */
                this.emit('event', message);
                break;
            default:
                /**
                 * @event DiscordConnector#event
                 * @type {Object}
                 * @description Emitted once an event was received from discord
                 * @private
                 */
                this.emit('event', message);
        }
    }

    /**
     * Handle a close from the underlying websocket
     * @param {Number} code - websocket close code
     * @param {String} reason - close reason if any
     * @protected
     */
    handleWsClose(code, reason) {
        let forceIdentify = false;
        let gracefulClose = false;
        this.status = 'disconnected';
        if (code === 4004) {
            /**
             * @event DiscordConnector#error
             * @type {String}
             * @description Emitted when the token was invalid
             * @private
             */
            this.emit('error', 'Tried to connect with an invalid token');
            return;
        }
        if (code === 4010) {
            /**
             * @event DiscordConnector#error
             * @type {String}
             * @description Emitted when the user tried to connect with bad sharding data
             * @private
             */
            this.emit('error', 'Invalid sharding data, check your client options');
            return;
        }
        if (code === 4011) {
            /**
             * @event DiscordConnector#error
             * @type {String}
             * @description Emitted when the shard would be on over 2500 guilds
             * @private
             */
            this.emit('error', 'Shard would be on over 2500 guilds. Add more shards');
            return;
        }
        // force identify if the session is marked as invalid
        if (code === 4009) {
            forceIdentify = true;
        }
        // don't try to reconnect when true
        if (code === 1000 && reason === 'Disconnect from User') {
            gracefulClose = true;
        }
        clearInterval(this.heartbeatInterval);
        this.betterWs.removeAllListeners();
        /**
         * @event DiscordConnector#disconnect
         * @type {Object}
         * @property {Number} code - websocket disconnect code
         * @private
         */
        this.emit('disconnect', code, reason, forceIdentify, gracefulClose);
    }

    /**
     * Send a status update payload to discord
     * @param {Presence} data - presence data to send
     * @protected
     */
    statusUpdate(data = {}) {
        return this.betterWs.sendMessage({op: OP.STATUS_UPDATE, d: this._checkPresenceData(data)});
    }

    /**
     * Send a voice state update payload to discord
     * @param {VoiceStateUpdate} data - voice state update data to send
     * @returns {Promise.<void>}
     * @protected
     */
    voiceStateUpdate(data) {
        if (!data) {
            return Promise.resolve();
        }
        return this.betterWs.sendMessage({op: OP.VOICE_STATE_UPDATE, d: this._checkVoiceStateUpdateData(data)});
    }

    /**
     * Send a request guild members payload to discord
     * @param {RequestGuildMembers} data - data to send
     * @returns {Promise.<void>}
     * @protected
     */
    requestGuildMembers(data = {}) {
        return this.betterWs.sendMessage({op: OP.REQUEST_GUILD_MEMBERS, d: this._checkRequestGuildMembersData(data)});
    }

    /**
     * Checks the presence data and fills in missing elements
     * @param {Object} data - data to send
     * @returns {Object} data after it's fixed/checked
     * @private
     */
    _checkPresenceData(data) {
        data.status = data.status || 'online';
        data.game = data.game || null;
        if (data.game && !data.game.type) {
            data.game.type = data.game.url ? 1 : 0;
        }
        if (data.game && !data.game.name) {
            data.game = null;
        }
        data.afk = data.afk || false;
        data.since = data.since || false;
        return data;
    }

    /**
     * Checks the voice state update data and fills in missing elements
     * @param {Object} data - data to send
     * @returns {Object} data after it's fixed/checked
     * @private
     */
    _checkVoiceStateUpdateData(data) {
        data.channel_id = data.channel_id || null;
        data.self_mute = data.self_mute || false;
        data.self_deaf = data.self_deaf || false;
        return data;
    }

    /**
     * Checks the request guild members data and fills in missing elements
     * @param {Object} data - data to send
     * @returns {Object} data after it's fixed/checked
     * @private
     */
    _checkRequestGuildMembersData(data) {
        data.query = data.query || '';
        data.limit = data.limit || 0;
        return data;
    }
}

module.exports = DiscordConnector;
