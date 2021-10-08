"use strict";
const { Client } = require("cloudstorm");
const token = require("../config.json").token;
const bot = new Client(token, {
	initialPresence: {status: "online", activities: [{name: "Wolking on Sunshine"}]},
	intents: ["GUILDS"],
	firstShardId: 0,
	lastShardId: 0,
	shardAmount: 1
});
const amqp = require("amqp");
const startup = async () => {
	const connection = amqp.createConnection({host: "localhost"});
	connection.on("error", (e) => {
		console.error(e);
	});
	connection.on("ready", async () => {
		await bot.connect();
		bot.on("event", (event) => {
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
