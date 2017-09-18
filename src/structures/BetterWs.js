'use strict';
let EventEmitter;
try {
    EventEmitter = require('eventemitter3');
} catch (e) {
    EventEmitter = require('events').EventEmitter;
}
let Erlpack;
try {
    Erlpack = require('erlpack');
} catch (e) {// eslint-disable-next-line no-empty
}
let WebSocket = require('ws');

class BetterWs extends EventEmitter {
    constructor(adress, protocols, options) {
        super();
        this.ws = new WebSocket(adress, protocols, options);
        this.bindWs(this.ws);
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
        this.bindWs(this.ws);
    }

    onOpen() {
        this.emit('ws_open');
    }

    onMessage(message) {
        try {
            if (Erlpack) {
                message = Erlpack.unpack(message);
            } else {
                message = JSON.parse(message);
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

            this.ws.send(data, {}, (e) => {
                if (e) {
                    return rej(e);
                }
                res();
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
