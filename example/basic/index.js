"use strict";
let CloudStorm = require("../../");
let token = require("../config.json").token;
let bot = new CloudStorm(token);
let startup = async () => {
	await bot.connect();
	bot.on("event", (event) => {
		// Do stuff with the received event ¯\_(ツ)_/¯
	});
	bot.on("ready", () => {
		console.log("Bot received ready event");
	});
};
startup().catch(e => {
	console.error("Error on startup!");
	console.error(e);
});
