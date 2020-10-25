"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const Shard_1 = __importDefault(require("./Shard"));
class ShardManager {
    constructor(client) {
        this.client = client;
        this.options = client.options;
        if (!this.options.connectQueueInterval) {
            this.options.connectQueueInterval = 1000 * 5;
        }
        this.shards = {};
        this.connectQueue = [];
        this.lastConnectionAttempt = null;
        this.connectQueueInterval = setInterval(() => {
            this._checkQueue();
        }, this.options.connectQueueInterval);
    }
    spawn() {
        const firstShardID = this.options.firstShardId ? this.options.firstShardId : 0;
        const lastShardId = this.options.lastShardId ? this.options.lastShardId : 0;
        for (let i = firstShardID; i < lastShardId + 1; i++) {
            this.client.emit("debug", `Spawned shard ${i}`);
            this.shards[i] = new Shard_1.default(i, this.client);
            this.connectQueue.push({ action: "connect", shard: this.shards[i] });
            this._addListener(this.shards[i]);
        }
    }
    disconnect() {
        for (const shardKey in this.shards) {
            if (this.shards.hasOwnProperty(shardKey)) {
                const shard = this.shards[shardKey];
                shard.disconnect();
            }
        }
    }
    _connectShard(data) {
        const { action, shard } = data;
        this.client.emit("debug", `${action === "connect" ? "Connecting" : "Identifying"} Shard ${shard.id} Status: ${shard.connector.status} Ready: ${shard.ready}`);
        if (this.lastConnectionAttempt && (this.lastConnectionAttempt <= Date.now() - 6000)) {
            switch (action) {
                case "identify":
                    this.lastConnectionAttempt = Date.now();
                    this.client.emit("debug", `Identifying shard ${shard.id}`);
                    shard.connector.identify(true);
                    break;
                case "connect":
                default:
                    if (shard.connector.status !== "connecting" && !shard.ready) {
                        this.lastConnectionAttempt = Date.now();
                        this.client.emit("debug", `Connecting shard ${shard.id}`);
                        shard.connect();
                    }
                    break;
            }
        }
    }
    _checkQueue() {
        this.client.emit("debug", `Checking queue Length: ${this.connectQueue.length} LastAttempt: ${this.lastConnectionAttempt} Current Time: ${Date.now()}`);
        if (this.connectQueue.length > 0 && (this.lastConnectionAttempt && (this.lastConnectionAttempt <= Date.now() - 6000))) {
            const toConnect = this.connectQueue.splice(0, 1);
            for (const shard of toConnect) {
                this._connectShard(shard);
            }
        }
    }
    _addListener(shard) {
        shard.on("ready", (resume) => {
            this.shards[shard.id].ready = true;
            this.client.emit("debug", `Shard ${shard.id} ${resume ? "has resumed" : "is ready"}`);
            this.client.emit("shardReady", { id: shard.id, ready: !resume });
            this._checkReady();
        });
        shard.on("error", (error) => {
            this.client.emit("error", error);
        });
        shard.on("disconnect", (code, reason, forceIdentify, gracefulClose) => {
            this.client.emit("debug", `${shard.id} ws closed with code ${code} and reason: ${reason}`);
            if (code === 1000 && gracefulClose) {
                this._checkDisconnect();
                return;
            }
            shard.forceIdentify = forceIdentify;
            this.connectQueue.push({ action: "connect", shard });
        });
        shard.on("queueIdentify", (shardId) => {
            if (!this.shards[shardId]) {
                this.client.emit("debug", `Received a queueIdentify event for not existing shard ${shardId}`);
                return;
            }
            this.connectQueue.unshift({ action: "identify", shard: this.shards[shardId] });
        });
    }
    _checkReady() {
        for (let shardId in this.shards) {
            if (this.shards.hasOwnProperty(shardId)) {
                if (!this.shards[shardId].ready) {
                    return;
                }
            }
        }
        this.client.emit("ready");
    }
    _checkDisconnect() {
        for (let shardId in this.shards) {
            if (this.shards.hasOwnProperty(shardId)) {
                if (this.shards[shardId].connector.status !== "disconnected") {
                    return;
                }
            }
        }
        this.client.emit("disconnected");
    }
    async statusUpdate(data = {}) {
        let shardPromises = [];
        for (let shardKey in this.shards) {
            if (this.shards.hasOwnProperty(shardKey)) {
                let shard = this.shards[shardKey];
                if (shard.ready) {
                    shardPromises.push(shard.statusUpdate(data));
                }
            }
        }
        await Promise.all(shardPromises);
    }
    shardStatusUpdate(shardId, data = {}) {
        return new Promise((res, rej) => {
            let shard = this.shards[shardId];
            if (!shard) {
                rej(new Error(`Shard ${shardId} does not exist`));
            }
            if (!shard.ready) {
                shard.once("ready", () => {
                    shard.statusUpdate(data).then(result => res(result)).catch(e => rej(e));
                });
            }
            shard.statusUpdate(data).then(result => res(result)).catch(e => rej(e));
        });
    }
    voiceStateUpdate(shardId, data) {
        return new Promise((res, rej) => {
            let shard = this.shards[shardId];
            if (!shard) {
                rej(new Error(`Shard ${shardId} does not exist`));
            }
            if (!shard.ready) {
                shard.once("ready", () => {
                    shard.voiceStateUpdate(data).then(result => res(result)).catch(e => rej(e));
                });
            }
            shard.voiceStateUpdate(data).then(result => res(result)).catch(e => rej(e));
        });
    }
    requestGuildMembers(shardId, data) {
        return new Promise((res, rej) => {
            let shard = this.shards[shardId];
            if (!shard) {
                rej(new Error(`Shard ${shardId} does not exist`));
            }
            if (!shard.ready) {
                shard.once("ready", () => {
                    shard.requestGuildMembers(data).then(result => res(result)).catch(e => rej(e));
                });
            }
            shard.requestGuildMembers(data).then(result => res(result)).catch(e => rej(e));
        });
    }
}
module.exports = ShardManager;
