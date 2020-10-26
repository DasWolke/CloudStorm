"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const version = require("../package.json").version;
const events_1 = require("events");
let Erlpack;
try {
    Erlpack = require("erlpack");
}
catch (e) { }
const Constants_1 = __importDefault(require("./Constants"));
const snowtransfer_1 = __importDefault(require("snowtransfer"));
const ShardManager_1 = __importDefault(require("./ShardManager"));
class Client extends events_1.EventEmitter {
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
            intents: 0,
            token: ""
        };
        this.token = token.startsWith("Bot ") ? token.substring(4) : token;
        Object.assign(this.options, options);
        this.options.token = token;
        this.shardManager = new ShardManager_1.default(this);
        this.version = version;
        this._restClient = new snowtransfer_1.default(token);
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
    static get Constants() {
        return Constants_1.default;
    }
    async connect() {
        const gatewayUrl = await this.getGateway();
        this._updateEndpoint(gatewayUrl);
        this.shardManager.spawn();
    }
    async getGateway() {
        const gatewayData = await this._restClient.bot.getGateway();
        return gatewayData.url;
    }
    async getGatewayBot() {
        return this._restClient.bot.getGatewayBot();
    }
    disconnect() {
        return this.shardManager.disconnect();
    }
    async statusUpdate(data) {
        await this.shardManager.statusUpdate(data);
        void undefined;
    }
    shardStatusUpdate(shardId, data) {
        return this.shardManager.shardStatusUpdate(shardId, data);
    }
    voiceStateUpdate(shardId, data) {
        return this.shardManager.voiceStateUpdate(shardId, data);
    }
    requestGuildMembers(shardId, data) {
        if (!data.guild_id) {
            throw new Error("You need to pass a guild_id");
        }
        return this.shardManager.requestGuildMembers(shardId, data);
    }
    _updateEndpoint(gatewayUrl) {
        this.options.endpoint = `${gatewayUrl}?v=${Constants_1.default.GATEWAY_VERSION}&encoding=${Erlpack ? "etf" : "json"}&compress=zlib-stream`;
    }
}
module.exports = Client;
