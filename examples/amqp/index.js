"use strict";

const { Client } = require("../../");
const { PresenceUpdateStatus } = require("discord-api-types/v10");

const token = require("../config.json").token;
const bot = new Client(token, {
	initialPresence: {
		status: PresenceUpdateStatus.Online,
		since: null,
		afk: false,
		activities: [{
			name: "Wolking on Sunshine",
			type: 1
		}]
	},
	intents: ["GUILDS"],
	shards: [0],
	totalShards: 1
});

const amqp = require("amqp");
const startup = async () => {
	const connection = amqp.createConnection({ host: "localhost" });
	connection.on("error", e => {
		console.error(e);
	});
	connection.on("ready", async () => {
		await bot.connect();
		bot.on("event", event => {
			connection.publish("test-pre-cache", event);
			// Event was sent to amqp queue, now you can use it somewhere else
		});
	});
	bot.on("ready", () => {
		console.log("Bot is ready");
	});
};
startup().catch(e => {
	console.error("Error on startup!");
	console.error(e);
});
