'use strict';
let Shard = require('./Shard');

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
            this.checkQueue();
        }, this.options.connectQueueInterval);
    }

    spawn() {
        for (let i = this.options.firstShardId; i < this.options.lastShardId + 1; i++) {
            this.client.emit('debug', `Spawned shard ${i}`);
            this.shards[i] = new Shard(i, this.client);
            this.connectQueue.push(this.shards[i]);
            this.addListener(this.shards[i]);
        }
    }

    connectShard(shard) {
        this.client.emit('debug', `Connecting Shard ${shard.id} Status: ${shard.connector.status} Ready: ${shard.ready}`);
        if (this.lastConnectionAttempt <= Date.now() - 6000 && shard.connector.status !== 'connecting' && !shard.ready) {
            this.lastConnectionAttempt = Date.now();
            this.client.emit('debug', `Connecting shard ${shard.id}`);
            shard.connect();
        }
    }

    checkQueue() {
        this.client.emit('debug', `Checking queue Length: ${this.connectQueue.length} LastAttempt: ${this.lastConnectionAttempt} Current Time: ${Date.now()}`);
        if (this.connectQueue.length > 0 && this.lastConnectionAttempt <= Date.now() - 6000) {
            this.connectShard(...this.connectQueue.splice(0, 1));
            this.lastConnectionAttempt = Date.now();
        }
    }

    addListener(shard) {
        shard.on('ready', () => {
            this.shards[shard.id].ready = true;
            this.client.emit('debug', `Shard ${shard.id} is ready`);
            this.checkReady();
        });
        shard.on('error', (error) => {
            this.client.emit('error', error);
        });
        shard.on('disconnect', (code, reason, forceIdentify) => {
            this.client.emit('debug', `${shard.id} ws closed with code ${code} and reason: ${reason}`);
            shard.forceIdentify = forceIdentify;
            this.connectQueue.push(shard);
        });
    }

    checkReady() {
        for (let shardId in this.shards) {
            if (this.shards.hasOwnProperty(shardId)) {
                if (!this.shards[shardId].ready) {
                    return;
                }
            }
        }
        this.client.emit('ready');
    }

    statusUpdate(data = {}) {
        for (let shardKey in this.shards) {
            if (this.shards.hasOwnProperty(shardKey)) {
                let shard = this.shards[shardKey];
                if (shard.ready) {
                    shard.statusUpdate(data);
                }
            }
        }
    }

}

module.exports = ShardManager;
