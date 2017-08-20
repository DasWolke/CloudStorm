'use strict';
let Shard = require('./Shard');

class ShardManager {
    constructor(client) {
        this.client = client;
        this.options = client.options;
        this.shards = {};
        this.connectQueue = [];
        this.lastConnectionAttempt = null;
        this.queueTimeout = null;
    }

    spawn() {
        for (let i = this.options.firstShardId; i < this.options.lastShardId + 1; i++) {
            console.log(`Spawned shard ${i}`);
            this.shards[i] = new Shard(i, this.client);
            this.connectQueue.push(this.shards[i]);
            this.addListener(this.shards[i]);
        }
        this.checkQueue();
    }

    connectShard(shard) {
        if (this.lastConnectionAttempt <= Date.now() - 6000 && shard.status !== 'connecting' && !shard.ready) {
            this.lastConnectionAttempt = Date.now();
            console.log(`Connecting shard ${shard.id}`);
            shard.connect();
            this.checkQueue();
        } else if (!this.queueTimeout) {
            this.checkQueue();
        }
    }

    checkQueue() {
        if (this.connectQueue.length > 0 && this.lastConnectionAttempt <= Date.now() - 6000) {
            this.connectShard(...this.connectQueue.splice(0, 1));
            this.lastConnectionAttempt = Date.now();
        } else if (!this.queueTimeout) {
            this.queueTimeout = setTimeout(() => {
                this.queueTimeout = null;
                this.checkQueue();
            }, 5000);
        }
    }

    addListener(shard) {
        shard.on('ready', () => {
            this.shards[shard.id].ready = true;
            console.log(`Shard ${shard.id} is ready`);
        });
    }

}

module.exports = ShardManager;
