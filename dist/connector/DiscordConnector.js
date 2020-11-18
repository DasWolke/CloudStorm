"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const events_1 = require("events");
const BetterWs_1 = __importDefault(require("../structures/BetterWs"));
const Constants_1 = require("../Constants");
const Intents_1 = __importDefault(require("../Intents"));
class DiscordConnector extends events_1.EventEmitter {
    constructor(id, client) {
        super();
        this.id = id;
        this.client = client;
        this.options = client.options;
        this.reconnect = this.options.reconnect || true;
        this.betterWs = null;
        this.heartbeatTimeout = null;
        this.heartbeatInterval = 0;
        this._trace = null;
        this.seq = 0;
        this.status = "init";
        this.sessionId = null;
        this.forceIdentify = false;
        this.lastACKAt = 0;
        this.lastHeartbeatSend = 0;
        this.latency = 0;
    }
    emit(event, ...args) {
        return super.emit(event, ...args);
    }
    once(event, listener) {
        return super.once(event, listener);
    }
    on(event, listener) {
        return super.on(event, listener);
    }
    connect() {
        if (!this.betterWs) {
            this.betterWs = new BetterWs_1.default(this.options.endpoint);
        }
        else {
            this.betterWs.removeAllListeners();
            this.betterWs.recreateWs(this.options.endpoint);
        }
        this.betterWs.on("ws_open", () => {
            this.status = "connecting";
        });
        this.betterWs.on("ws_message", this.messageAction);
        this.betterWs.on("ws_close", this.handleWsClose);
        this.betterWs.on("debug", event => {
            this.client.emit("debug", event);
        });
        this.betterWs.on("debug_send", data => {
            this.client.emit("rawSend", data);
        });
    }
    async disconnect() {
        var _a;
        return (_a = this.betterWs) === null || _a === void 0 ? void 0 : _a.close(1000, "Disconnected by User");
    }
    async messageAction(message) {
        this.client.emit("rawReceive", message);
        if (message.s) {
            if (message.s > this.seq + 1) {
                this.client.emit("debug", `Shard ${this.id}, invalid sequence: current: ${this.seq} message: ${message.s}`);
                this.seq = message.s;
                this.resume();
            }
            this.seq = message.s;
        }
        switch (message.op) {
            case Constants_1.GATEWAY_OP_CODES.DISPATCH:
                this.handleDispatch(message);
                break;
            case Constants_1.GATEWAY_OP_CODES.HEARTBEAT:
                this.heartbeat();
                break;
            case Constants_1.GATEWAY_OP_CODES.RECONNECT:
                this.client.emit("debug", `Gateway asked shard ${this.id} to reconnect`);
                if (this.options.reconnect)
                    this._reconnect(true);
                else
                    this.disconnect();
                break;
            case Constants_1.GATEWAY_OP_CODES.INVALID_SESSION:
                if (message.d && this.sessionId) {
                    this.resume();
                }
                else {
                    this.seq = 0;
                    this.sessionId = "";
                    this.emit("queueIdentify", this.id);
                }
                break;
            case Constants_1.GATEWAY_OP_CODES.HELLO:
                this.heartbeat();
                this.heartbeatInterval = message.d.heartbeat_interval;
                this.heartbeatTimeout = setInterval(() => {
                    if (this.lastACKAt <= Date.now() - (this.heartbeatInterval + 5000)) {
                        this.client.emit("debug", `Shard ${this.id} has not received a heartbeat ACK in ${this.heartbeatInterval + 5000}ms.`);
                        if (this.options.reconnect)
                            this._reconnect(true);
                        else
                            this.disconnect();
                    }
                    else {
                        this.heartbeat();
                    }
                }, this.heartbeatInterval);
                this._trace = message.d._trace;
                this.identify();
                this.client.emit("debug", `Shard ${this.id} received HELLO`);
                break;
            case Constants_1.GATEWAY_OP_CODES.HEARTBEAT_ACK:
                this.lastACKAt = Date.now();
                this.latency = this.lastACKAt - this.lastHeartbeatSend;
                break;
            default:
                this.emit("event", message);
        }
    }
    async _reconnect(resume = false) {
        var _a;
        await ((_a = this.betterWs) === null || _a === void 0 ? void 0 : _a.close(resume ? 4000 : 1012, "reconnecting"));
        if (resume) {
            this.clearHeartBeat();
        }
        else {
            this.reset();
        }
        this.connect();
    }
    reset() {
        this.sessionId = null;
        this.seq = 0;
        this.lastACKAt = 0;
        this._trace = null;
        this.clearHeartBeat();
    }
    clearHeartBeat() {
        if (this.heartbeatTimeout)
            clearInterval(this.heartbeatTimeout);
        this.heartbeatTimeout = null;
        this.heartbeatInterval = 0;
    }
    async identify(force) {
        var _a;
        if (this.sessionId && !this.forceIdentify && !force) {
            return this.resume();
        }
        const data = {
            op: Constants_1.GATEWAY_OP_CODES.IDENTIFY,
            d: {
                token: this.options.token,
                properties: {
                    os: process.platform,
                    browser: "CloudStorm",
                    device: "CloudStorm"
                },
                large_threshold: this.options.largeGuildThreshold,
                shard: [this.id, this.options.shardAmount],
                intents: this.options.intents ? Intents_1.default.resolve(this.options.intents) : 0
            }
        };
        if (this.options.initialPresence)
            Object.assign(data.d, { presence: this._checkPresenceData(this.options.initialPresence) });
        this.forceIdentify = false;
        return (_a = this.betterWs) === null || _a === void 0 ? void 0 : _a.sendMessage(data);
    }
    async resume() {
        var _a;
        return (_a = this.betterWs) === null || _a === void 0 ? void 0 : _a.sendMessage({
            op: Constants_1.GATEWAY_OP_CODES.RESUME,
            d: { seq: this.seq, token: this.options.token, session_id: this.sessionId }
        });
    }
    heartbeat() {
        var _a;
        (_a = this.betterWs) === null || _a === void 0 ? void 0 : _a.sendMessage({ op: Constants_1.GATEWAY_OP_CODES.HEARTBEAT, d: this.seq });
        this.lastHeartbeatSend = Date.now();
    }
    handleDispatch(message) {
        switch (message.t) {
            case "READY":
            case "RESUMED":
                if (message.t === "READY") {
                    this.sessionId = message.d.session_id;
                }
                this.status = "ready";
                this._trace = message.d._trace;
                this.emit("ready", message.t === "RESUMED");
                this.emit("event", message);
                break;
            default:
                this.emit("event", message);
        }
    }
    handleWsClose(code, reason) {
        var _a;
        let forceIdentify = false;
        let gracefulClose = false;
        this.status = "disconnected";
        if (code === 4014) {
            this.emit("error", "Disallowed Intents, check your client options and application page.");
            return;
        }
        if (code === 4013) {
            this.emit("error", "Invalid Intents data, check your client options.");
            return;
        }
        if (code === 4012) {
            this.emit("error", "Invalid API version.");
            return;
        }
        if (code === 4011) {
            this.emit("error", "Shard would be on over 2500 guilds. Add more shards.");
            return;
        }
        if (code === 4010) {
            this.emit("error", "Invalid sharding data, check your client options.");
            return;
        }
        if (code === 4009) {
            this.emit("error", "Session timed out.");
            forceIdentify = true;
        }
        if (code === 4008) {
            this.emit("error", "You are being rate limited. Wait before sending more packets.");
            return;
        }
        if (code === 4007) {
            this._reconnect();
            return;
        }
        if (code === 4005) {
            this.emit("error", "You sent more than one OP 2 IDENTIFY payload while the websocket was open.");
        }
        if (code === 4004) {
            this.emit("error", "Tried to connect with an invalid token");
            return;
        }
        if (code === 4003) {
            this.emit("error", "You tried to send a packet before sending an OP 2 IDENTIFY or OP 6 RESUME.");
        }
        if (code === 1000 && reason === "Disconnected by User") {
            gracefulClose = true;
        }
        this.clearHeartBeat();
        (_a = this.betterWs) === null || _a === void 0 ? void 0 : _a.removeAllListeners();
        this.emit("disconnect", code, reason, forceIdentify, gracefulClose);
    }
    async presenceUpdate(data = {}) {
        var _a;
        return (_a = this.betterWs) === null || _a === void 0 ? void 0 : _a.sendMessage({ op: Constants_1.GATEWAY_OP_CODES.PRESENCE_UPDATE, d: this._checkPresenceData(data) });
    }
    async voiceStateUpdate(data) {
        var _a;
        if (!data) {
            return Promise.resolve();
        }
        return (_a = this.betterWs) === null || _a === void 0 ? void 0 : _a.sendMessage({ op: Constants_1.GATEWAY_OP_CODES.VOICE_STATE_UPDATE, d: this._checkVoiceStateUpdateData(data) });
    }
    async requestGuildMembers(data) {
        var _a;
        return (_a = this.betterWs) === null || _a === void 0 ? void 0 : _a.sendMessage({ op: Constants_1.GATEWAY_OP_CODES.REQUEST_GUILD_MEMBERS, d: this._checkRequestGuildMembersData(data) });
    }
    _checkPresenceData(data) {
        data.status = data.status || "online";
        data.activities = data.activities && Array.isArray(data.activities) ? data.activities : null;
        if (data.activities) {
            for (const activity of data.activities) {
                const index = data.activities.indexOf(activity);
                if (activity.type === undefined)
                    activity.type = activity.url ? 1 : 0;
                if (!activity.name)
                    data.activities.splice(index, 1);
            }
        }
        data.afk = data.afk || false;
        data.since = data.since || false;
        return data;
    }
    _checkVoiceStateUpdateData(data) {
        data.channel_id = data.channel_id || null;
        data.self_mute = data.self_mute || false;
        data.self_deaf = data.self_deaf || false;
        return data;
    }
    _checkRequestGuildMembersData(data) {
        data.query = data.query || "";
        data.limit = data.limit || 0;
        return data;
    }
}
module.exports = DiscordConnector;
