# A minimal discord gateway library

Part of the WeatherStack

CloudStorm is a small library specially made to **only** cover the Gateway area of the discord api.

It makes no assumptions about the rest of your stack, therefore you can use it anywhere as long as you use node 12 or higher.

## Some of the things that make CloudStorm awesome:
- Standalone discord gateway connection
- zlib-stream, etf and json support
- Well documented

## Example:
```js
const { Client } = require("cloudstorm");
const bot = new Client(token, { intents: ["GUILDS"] });
const startup = async () => {
	await bot.connect();
	bot.on("ready", () => console.log("Bot received ready event"););
};
startup().catch(e => {
	console.error("Error on startup!");
	console.error(e);
});
```

## Gotchas with CloudStorm:
You may wonder how you you are able to get the id of a shard where an event originated from, but don't fear, CloudStorm helps you with that by adding a `shard_id` property to the events that are forwarded.

So an event you receive may look like this:
```json
{
	"op":0,
	"t":"PRESENCE_UPDATE",
	"s":1337,
	"shard_id":0,
	"d": {
		"game": null,
		"guild_id": "id",
		"nick": null,
		"roles": [],
		"status": "offline",
		"user": {
			"id": "id"
		}
	}
}
```

## Sharding for VERY large bots
CloudStorm supports max_concurrency, but does not automatically attempt to fetch new info related to max_concurrency. You are expected to re-fetch this data at your own discretion as Discord does not recommend caching the data for extended periods as it can change as your client leaves and joins guilds and possibly cause rate limit errors.

You should start your clusters 1 by 1 as rate limit info is only fetched on Client.connect or when you manually call Client.fetchConnectInfo when /gateway/bot is fetched

### Microservice Bots:
I've written a general whitepaper on the idea of microservice bots, which you can find on gist: [Microservice Bot Whitepaper](https://gist.github.com/DasWolke/c9d7dfe6a78445011162a12abd32091d)

### Documentation:
You can find the docs at [https://daswolke.github.io/CloudStorm/](https://daswolke.github.io/CloudStorm/)

### Installation:
To install CloudStorm, make sure that you have node 12 or higher and npm installed on your computer.

Then run the following command in a terminal `npm install cloudstorm`
