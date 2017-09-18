'use strict';
let version = require('../package.json').version;
let EventEmitter;
try {
    EventEmitter = require('eventemitter3');
} catch (e) {
    EventEmitter = require('events').EventEmitter;
}
let Erlpack;
try {
    Erlpack = require('erlpack');
// eslint-disable-next-line no-empty
} catch (e) {

}
const Constants = require('./Constants');
const axios = require('axios');
const httpClient = axios.create({
    baseURL: `https://discordapp.com/api/v${Constants.API_VERSION}`,
    headers: {'User-Agent': `DiscordBot (https://github.com/DasWolke/CloudStorm, ${version})`}
});
const ShardManager = require('./ShardManager');

class Client extends EventEmitter {
    constructor(token, options = {}) {
        super();
        if (!token) {
            throw new Error('Missing token!');
        }
        this.options = {
            compress: true,
            large_guild_threshold: 250,
            firstShardId: 0,
            lastShardId: 0,
            shardAmount: 1,
            reconnect: true,
            initialPresence: {status: 'online', game: {name: 'CloudStorm'}}
        };
        this.token = token.startsWith('Bot ') ? token.substring(4) : token;
        this.httpToken = this.token.startsWith('Bot ') ? this.token : `Bot ${this.token}`;
        Object.assign(this.options, options);
        this.options.token = token;
        this.shardManager = new ShardManager(this);
    }

    async connect() {
        let gatewayUrl = await this.getGateway();
        this.options.endpoint = `${gatewayUrl}?v=${Constants.GATEWAY_VERSION}&encoding=${Erlpack ? 'etf' : 'json'}`;
        this.shardManager.spawn();
    }

    async getGateway() {
        let gatewayRequest = await httpClient({
            url: '/gateway',
            headers: {Authorization: this.httpToken},
            method: 'get'
        });
        return gatewayRequest.data.url;
    }

    async disconnect() {

    }

    statusUpdate(data) {
        this.shardManager.statusUpdate(data);
    }
}

module.exports = Client;
