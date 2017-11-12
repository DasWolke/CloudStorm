'use strict';
let EventEmitter;
try {
    EventEmitter = require('eventemitter3');
} catch (e) {
    EventEmitter = require('events').EventEmitter;
}
const zlib = require('zlib-sync');
let Erlpack;
try {
    Erlpack = require('erlpack');
} catch (e) {// eslint-disable-next-line no-empty
}
const GATEWAY_OP_CODES = require('../Constants').GATEWAY_OP_CODES;
let WebSocket = require('ws');
let RatelimitBucket = require('./RatelimitBucket');

/**
 * @typedef BetterWs
 * @description Helper Class for simplifying the websocket connection to discord
 * @property {WebSocket} ws - the raw websocket connection
 * @property {RatelimitBucket} wsBucket - ratelimit bucket for the general websocket connection
 * @property {RatelimitBucket} statusBucket - ratelimit bucket for the 5/60s status update ratelimit
 * @property {zlib} zlibInflate - shared zlibInflate context for inflating zlib compressed messages received from discord
 * @private
 */
class BetterWs extends EventEmitter {
    /**
     * Create a new BetterWs instance
     * @param {String} address
     * @param {Object} options
     * @private
     */
    constructor(address, options = {}) {
        super();
        this.ws = new WebSocket(address, options);
        this.bindWs(this.ws);
        this.wsBucket = new RatelimitBucket(120, 60000);
        this.statusBucket = new RatelimitBucket(5, 60000);
        this.zlibInflate = new zlib.Inflate({
            chunkSize: 65535,
            flush: zlib.Z_SYNC_FLUSH,
        });
    }

    /**
     * Get the raw websocket connection currently used
     * @returns {WebSocket}
     * @protected
     */
    get rawWs() {
        return this.ws;
    }

    /**
     * Add eventlisteners to a passed websocket connection
     * @param {WebSocket} ws - websocket
     * @protected
     */
    bindWs(ws) {
        ws.on('message', (msg) => {
            this.onMessage(msg);
        });
        ws.on('close', (code, reason) => this.onClose(code, reason));
        ws.on('error', (err) => {
            /**
             * @event BetterWs#error
             * @type {Error}
             * @description Emitted upon errors from the underlying websocket
             * @private
             */
            this.emit('error', err);
        });
        ws.on('open', () => this.onOpen());
    }

    /**
     * Create a new Websocket Connection if the old one was closed/destroyed
     * @param {String} address - address to connect to
     * @param {Object} options - options used by the websocket connection
     * @protected
     */
    recreateWs(address, options = {}) {
        this.ws.removeAllListeners();
        this.zlibInflate = new zlib.Inflate({
            chunkSize: 65535,
            flush: zlib.Z_SYNC_FLUSH,
        });
        this.ws = new WebSocket(address, options);
        this.options = options;
        this.wsBucket.dropQueue();
        this.wsBucket = new RatelimitBucket(120, 60000);
        this.statusBucket = new RatelimitBucket(5, 60000);
        this.bindWs(this.ws);
    }

    /**
     * Called upon opening of the websocket connection
     * @protected
     */
    onOpen() {
        /**
         * @event BetterWs#ws_open
         * @type {void}
         * @description Emitted once the underlying websocket connection has opened
         * @private
         */
        this.emit('ws_open');
    }

    /**
     * Called once a websocket message is received,
     * uncompresses the message using zlib and parses it via Erlpack or JSON.parse
     * @param {Object|Buffer|String} message - message received by websocket
     * @protected
     */
    onMessage(message) {
        try {
            const length = message.length;
            const flush = length >= 4 &&
                message[length - 4] === 0x00 &&
                message[length - 3] === 0x00 &&
                message[length - 2] === 0xFF &&
                message[length - 1] === 0xFF;
            this.zlibInflate.push(message, flush && zlib.Z_SYNC_FLUSH);
            if (!flush) return;
            if (Erlpack) {
                message = Erlpack.unpack(this.zlibInflate.result);
            } else {
                message = JSON.parse(this.zlibInflate.result);
            }
        } catch (e) {
            /**
             * @event BetterWs#error
             * @type {String}
             * @description Emitted upon parse errors of messages
             * @private
             */
            this.emit('error', `Message: ${message} was not parseable`);
            return;
        }
        /**
         * @event BetterWs#ws_message
         * @type {Object}
         * @description Emitted upon successful parsing of a message with the parsed Message
         * @private
         */
        this.emit('ws_message', message);
    }

    /**
     * Called when the websocket connection closes for some reason
     * @param {Number} code - websocket close code
     * @param {String} reason - reason of the close if any
     * @protected
     */
    onClose(code, reason) {
        /**
         * @event BetterWs#ws_close
         * @type {void}
         * @param {Number} code - websocket close code
         * @param {String} reason - websocket close reason
         * @private
         */
        this.emit('ws_close', code, reason);
    }

    /**
     * Send a message to the discord gateway
     * @param {Object} data - data to send
     * @returns {Promise.<void>}
     * @protected
     */
    sendMessage(data) {
        /**
         * @event BetterWs#debug_send
         * @type {object}
         * @description Used for debugging the messages sent to discord's gateway
         * @private
         */
        this.emit('debug_send', data);
        return new Promise((res, rej) => {
            let status = data.op === GATEWAY_OP_CODES.STATUS_UPDATE;
            try {
                if (Erlpack) {
                    data = Erlpack.pack(data);
                } else {
                    data = JSON.stringify(data);
                }
            } catch (e) {
                return rej(e);
            }
            let sendMsg = () => {
                // The promise from wsBucket is ignored, since the method passed to it does not return a promise
                this.wsBucket.queue(() => {
                    this.ws.send(data, {}, (e) => {
                        if (e) {
                            return rej(e);
                        }
                        res();
                    });
                });
            };
            if (status) {
                // same here
                this.statusBucket.queue(sendMsg);
            } else {
                sendMsg();
            }
        });
    }

    /**
     * Close the current connection
     * @param {Number} code=1000 - websocket close code to use
     * @param {String} reason - reason of the disconnect
     * @returns {Promise.<void>}
     * @protected
     */
    close(code = 1000, reason = '') {
        return new Promise((res, rej) => {
            this.ws.close(code, reason);
            this.ws.once('close', () => {
                return res();
            });
            setTimeout(() => {
                return rej('Websocket not closed within 5 seconds');
            }, 5 * 1000);
        });

    }
}

module.exports = BetterWs;
