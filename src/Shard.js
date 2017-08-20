'use strict';
let EventEmitter;
try {
    EventEmitter = require('eventemitter3');
} catch (e) {
    EventEmitter = require('events').EventEmitter;
}
const DiscordConnector = require('./connector/DiscordConnector');

class Shard extends EventEmitter {
    constructor(id, client) {
        super();
        this.id = id;
        this.client = client;
        this.connector = new DiscordConnector(id, client);
        this.connector.on('event', (event) => {
            this.client.emit('event', event);
        });
        this.connector.on('error', (err) => {
            this.client.emit('error', err);
        });
        +
            this.connector.on('ready', () => {
                this.emit('ready');
            });
    }

    connect() {
        return this.connector.connect();
    }

}

module.exports = Shard;
