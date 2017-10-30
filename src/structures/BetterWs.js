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
let WebSocket = require('ws');
let RateLimitBucket = require('./RatelimitBucket');

class BetterWs extends EventEmitter {
    constructor(adress, protocols, options) {
        super();
        this.ws = new WebSocket(adress, protocols, options);
        this.bindWs(this.ws);
        this.wsBucket = new RateLimitBucket(120, 60000);
        this.zlibInflate = new zlib.Inflate({
            chunkSize: 65535,
            flush: zlib.Z_SYNC_FLUSH,
        });
    }

    get rawWs() {
        return this.ws;
    }

    bindWs(ws) {
        ws.on('message', (msg) => {
            this.onMessage(msg);
        });
        ws.on('close', (code, reason) => this.onClose(code, reason));
        ws.on('open', () => this.onOpen());
    }

    recreateWs(adress, options = {}) {
        this.ws.removeAllListeners();
        this.ws = new WebSocket(adress);
        this.options = options;
        this.wsBucket.dropQueue();
        this.wsBucket = new RateLimitBucket(120, 60000);
        this.bindWs(this.ws);
    }

    onOpen() {
        this.emit('ws_open');
    }

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
            this.emit('debug', `Message: ${message} was not parseable`);
            return;
        }
        this.emit('ws_message', message);
    }

    onClose(code, reason) {
        this.emit('ws_close', code, reason);
    }

    sendMessage(data) {
        this.emit('debug_send', data);
        return new Promise((res, rej) => {
            try {
                if (Erlpack) {
                    data = Erlpack.pack(data);
                } else {
                    data = JSON.stringify(data);
                }
            } catch (e) {
                return rej(e);
            }
            this.wsBucket.queue(() => {
                this.ws.send(data, {}, (e) => {
                    if (e) {
                        return rej(e);
                    }
                    res();
                });
            });
        });
    }

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

    terminate() {

    }
}

module.exports = BetterWs;
