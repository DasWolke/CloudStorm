'use strict';
let EventEmitter;
try {
    EventEmitter = require('eventemitter3');
} catch (e) {
    EventEmitter = require('events').EventEmitter;
}
const BetterWs = require('../structures/BetterWs');
const OP = require('../Constants').GATEWAY_OP_CODES;

class DiscordConnector extends EventEmitter {
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
    }

    connect() {
        this.betterWs = new BetterWs(this.options.endpoint);
        this.betterWs.on('ws_open', () => {
            this.status = 'connecting';
        });
        this.betterWs.on('ws_message', (msg) => {
            this.messageAction(msg);
        });
        this.betterWs.on('ws_close', (code, reason) => {
            this.handleWsClose(code, reason);
        });
    }

    messageAction(message) {
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
                }, message.d.heartbeat_interval);
                this._trace = message.d._trace;
                this.identify();
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
                    this.identify();
                }
                break;
            default:
                console.log(message);
                this.emit('event', message);
        }
    }

    reset() {
        this.sessionId = null;
        this.seq = 0;
        this._trace = null;
        this.heartbeatInterval = null;
    }

    identify(force) {
        if (this.sessionId && !force) {
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
                compress: false,
                large_threshold: 250,
                shard: [this.id, this.options.shardAmount],
                presence: this.checkPresenceData(this.options.initialPresence)
            }
        };
        this.betterWs.sendMessage(data);
    }

    resume() {
        this.betterWs.sendMessage({
            op: OP.RESUME,
            d: {seq: this.seq, token: this.options.token, session_id: this.sessionId}
        });
    }

    heartbeat() {
        this.betterWs.sendMessage({op: OP.HEARTBEAT, d: this.seq});
    }

    handleDispatch(message) {
        switch (message.t) {
            case 'READY':
                this.sessionId = message.d.session_id;
                this.status = 'ready';
                this.emit('ready');
                this.emit('event', message);
                break;
            case 'RESUME':
                this.status = 'ready';
                this.emit('ready');
                this.emit('event', message);
                break;
            default:
                this.emit('event', message);
        }
    }

    handleWsClose(code, reason) {
        console.log(code, reason);
        if (code === 4004) {
            this.emit('error', 'Tried to connect with an invalid token');
            return;
        }
        if (code === 4011) {
            this.emit('error', 'Shard would be on over 2500 guilds. Add more shards');
            return;
        }
        this.status = 'disconnected';
        clearInterval(this.heartbeatInterval);
        if (this.reconnect) {
            this.status = 'connecting';
            this.betterWs.recreateWs(this.options.endpoint);
        }
    }

    statusUpdate(data = {}) {
        this.betterWs.sendMessage({op: OP.STATUS_UPDATE, d: this.checkPresenceData(data)});
    }

    checkPresenceData(data) {
        data.status = data.status || 'online';
        data.game = data.game || {type: 0, name: 'owo'};
        if (!data.game.type) {
            data.game.type = data.game.url ? 1 : 0;
        }
        data.afk = data.afk || false;
        return data;
    }
}

module.exports = DiscordConnector;
