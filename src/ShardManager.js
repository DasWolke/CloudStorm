"use strict";
let Shard = require("./Shard");

/**
 * @typedef ShardManager
 * @description Class used for managing shards for the user
 *
 * This class is automatically instantiated by the library and is documented for reference
 * @property {Client} client - client that created this shard manager
 * @property {Object} options - options of the [client](Client.html)
 * @property {Object} shards - Object with a map of shards, mapped by shard id
 * @property {Array} connectQueue - Array containing shards that are not connected yet or have to be reconnected
 * @property {Date} lastConnectionAttempt - unix timestamp of the last time a shard tried connecting to discord
 * @property {Number} connectQueueInterval - Time in milliseconds for the interval checking any shards that may need to be connected to discord
 */
class ShardManager {
	/**
	 * Create a new ShardManager
	 * @param {Client} client
	 * @private
	 */
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

	/**
	 * Create the shard instances and add them to the connection queue
	 * @protected
	 */
	spawn() {
		for (let i = this.options.firstShardId; i < this.options.lastShardId + 1; i++) {
			/**
			 * @event Client#debug
			 * @type {String}
			 * @description used for debugging of the internals of the library
			 * @private
			 */
			this.client.emit("debug", `Spawned shard ${i}`);
			this.shards[i] = new Shard(i, this.client);
			this.connectQueue.push({action: "connect", shard: this.shards[i]});
			this._addListener(this.shards[i]);
		}
	}

	/**
	 * Disconnect all shards
	 * @protected
	 */
	disconnect() {
		for (let shardKey in this.shards) {
			if (this.shards.hasOwnProperty(shardKey)) {
				let shard = this.shards[shardKey];
				shard.disconnect();
			}
		}
	}

	/**
	 * Actually connect/re-identify a single shard by calling it's connect() or identify() method and reset the connection timer
	 * @param {Object} data - Object with a shard and action key
	 * @param {String} data.action - Action to execute, can either be `connect` or `identify`
	 * @param {Shard} data.shard - shard that should connect to discord
	 * @private
	 */
	_connectShard({action, shard}) {
		/**
		 * @event Client#debug
		 * @type {String}
		 * @description used for debugging of the internals of the library
		 * @private
		 */
		this.client.emit("debug", `${action === "connect" ? "Connecting" : "Identifying"} Shard ${shard.id} Status: ${shard.connector.status} Ready: ${shard.ready}`);
		if (this.lastConnectionAttempt <= Date.now() - 6000) {
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

	/**
	 * Check if there are shards that are not connected yet and connect them if over 6 seconds have passed since the last attempt
	 * @private
	 */
	_checkQueue() {
		/**
		 * @event Client#debug
		 * @type {String}
		 * @description used for debugging of the internals of the library
		 * @private
		 */
		this.client.emit("debug", `Checking queue Length: ${this.connectQueue.length} LastAttempt: ${this.lastConnectionAttempt} Current Time: ${Date.now()}`);
		if (this.connectQueue.length > 0 && this.lastConnectionAttempt <= Date.now() - 6000) {
			this._connectShard(...this.connectQueue.splice(0, 1));
		}
	}

	/**
	 * Add event listeners to a shard to that the manager can act on received events
	 * @param {Shard} shard - shard to add the event listeners to
	 * @private
	 */
	_addListener(shard) {
		shard.on("ready", (resume) => {
			this.shards[shard.id].ready = true;
			/**
			 * @event Client#debug
			 * @type {String}
			 * @description used for debugging of the internals of the library
			 * @private
			 */
			this.client.emit("debug", `Shard ${shard.id} ${resume ? "has resumed" : "is ready"}`);
			/**
			 * @event Client#shardReady
			 * @type {Object}
			 * @property {Number} id - id of the shard
			 * @property {Boolean} ready - whether the shard turned ready or resumed
			 * @description Emitted when a single shard resumes or turns ready
			 */
			this.client.emit("shardReady", {id: shard.id, ready: !resume});
			this._checkReady();
		});
		shard.on("error", (error) => {
			/**
			 * @event Client#error
			 * @type {Error}
			 * @description Emitted when an error occurs somewhere in the library
			 */
			this.client.emit("error", error);
		});

		shard.on("disconnect", (code, reason, forceIdentify, gracefulClose) => {
			/**
			 * @event Client#debug
			 * @type {String}
			 * @description used for debugging of the internals of the library
			 * @private
			 */
			this.client.emit("debug", `${shard.id} ws closed with code ${code} and reason: ${reason}`);
			if (code === 1000 && gracefulClose) {
				this._checkDisconnect();
				return;
			}
			shard.forceIdentify = forceIdentify;
			this.connectQueue.push({action: "connect", shard});
		});
		shard.on("queueIdentify", (shardId) => {
			if (!this.shards[shardId]) {
				this.client.emit("debug", `Received a queueIdentify event for not existing shard ${shardId}`);
				return;
			}
			this.connectQueue.unshift({action: "identify", shard: this.shards[shardId]});
		});
	}

	/**
	 * Checks if all shards are ready
	 * @private
	 */
	_checkReady() {
		for (let shardId in this.shards) {
			if (this.shards.hasOwnProperty(shardId)) {
				if (!this.shards[shardId].ready) {
					return;
				}
			}
		}
		/**
		 * @event Client#ready
		 * @type {void}
		 * @description Emitted when all shards turn ready
		 * @example
		 * //Connect bot to discord and get a log in the console once it's ready
		 * let bot = new CloudStorm(token)
		 * await bot.connect()
		 * bot.on('ready', () => {
		 *   // The bot has connected to discord successfully and authenticated with the gateway
		 * });
		 */
		this.client.emit("ready");
	}

	/**
	 * Checks if all shards are disconnected
	 * @private
	 */
	_checkDisconnect() {
		for (let shardId in this.shards) {
			if (this.shards.hasOwnProperty(shardId)) {
				if (this.shards[shardId].connector.status !== "disconnected") {
					return;
				}
			}
		}
		/**
		 * @event Client#disconnected
		 * @type {void}
		 * @description Emitted when all shards have disconnected successfully
		 */
		this.client.emit("disconnected");
	}

	/**
	 * Update the status of all currently connected shards
	 * @param {Presence} data - payload to send
	 * @protected
	 */
	statusUpdate(data = {}) {
		let shardPromises = [];
		for (let shardKey in this.shards) {
			if (this.shards.hasOwnProperty(shardKey)) {
				let shard = this.shards[shardKey];
				if (shard.ready) {
					shardPromises.push(shard.statusUpdate(data));
				}
			}
		}
		return Promise.all(shardPromises);
	}

	/**
	 * Update the status of a single connected shard
	 * @param {Number} shardId - internal id of the shard
	 * @param {Presence} data - payload to send
	 * @protected
	 */
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

	/**
	 * Send a voice state update payload with a certain shard
	 * @param {Number} shardId - id of the shard
	 * @param {VoiceStateUpdate} data - payload to send
	 * @returns {Promise.<void>}
	 * @protected
	 */
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

	/**
	 * Send a request guild members payload with a certain shard
	 * @param {Number} shardId - id of the shard
	 * @param {RequestGuildMembers} data - payload to send
	 * @returns {Promise.<void>}
	 * @protected
	 */
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
