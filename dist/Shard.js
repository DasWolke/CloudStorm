"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const events_1 = require("events");
const DiscordConnector_1 = __importDefault(require("./connector/DiscordConnector"));
const Constants_1 = require("./Constants");
class Shard extends events_1.EventEmitter {
    constructor(id, client) {
        super();
        this.id = id;
        this.client = client;
        this.forceIdentify = false;
        this.ready = false;
        this.connector = new DiscordConnector_1.default(id, client);
        this.connector.on("event", (event) => {
            const newEvent = Object.assign(event, { shard_id: this.id });
            this.client.emit("event", newEvent);
            switch (event.op) {
                case Constants_1.GATEWAY_OP_CODES.DISPATCH:
                    this.client.emit("dispatch", newEvent);
                    break;
                case Constants_1.GATEWAY_OP_CODES.VOICE_STATE_UPDATE:
                    this.client.emit("voiceStateUpdate", newEvent);
                    break;
                default:
                    break;
            }
        });
        this.connector.on("disconnect", (...args) => {
            this.ready = false;
            this.emit("disconnect", ...args);
        });
        this.connector.on("error", (err) => {
            this.emit("error", err);
        });
        this.connector.on("ready", (resume) => {
            this.emit("ready", resume);
        });
        this.connector.on("queueIdentify", () => {
            this.emit("queueIdentify", this.id);
        });
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
    get latency() {
        return this.connector.latency;
    }
    connect() {
        if (this.forceIdentify) {
            this.connector.forceIdentify = true;
            this.forceIdentify = false;
        }
        this.connector.connect();
    }
    disconnect() {
        return this.connector.disconnect();
    }
    presenceUpdate(data) {
        return this.connector.presenceUpdate(data);
    }
    voiceStateUpdate(data) {
        return this.connector.voiceStateUpdate(data);
    }
    requestGuildMembers(data) {
        return this.connector.requestGuildMembers(data);
    }
}
module.exports = Shard;
