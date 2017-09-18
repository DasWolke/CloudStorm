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
        this.forceIdentify = false;
        this.ready = false;
        this.connector = new DiscordConnector(id, client);
        this.connector.on('event', (event) => {
            this.client.emit('event', event);
        });
        this.connector.on('disconnect', (...args) => {
            this.ready = false;
            this.emit('disconnect', ...args);
        });
        this.connector.on('error', (err) => {
            this.emit('error', err);
        });
        this.connector.on('ready', () => {
            this.emit('ready');
        });
    }

    connect() {
        if (this.forceIdentify) {
            this.connector.forceIdentify = true;
            this.forceIdentify = false;
        }
        return this.connector.connect();
    }

    statusUpdate(data) {
        this.connector.statusUpdate(data);
    }

}

module.exports = Shard;
