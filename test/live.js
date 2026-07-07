"use strict";

// @ts-check

// Opt-in test against the REAL Discord gateway. Not part of `npm test`.
//
// Setup: copy test/config.example.js to test/config.js (git ignored) and fill in a bot token,
// or set the CS_TEST_TOKEN environment variable. Then run: npm run test:live
//
// Uses two identifies from the bot's daily session limit and briefly sets its presence.

const { test } = require("node:test");
const assert = require("node:assert/strict");

let token = process.env.CS_TEST_TOKEN || null;
try {
	token = require("./config.js").token || token;
} catch {
	// no config.js - the env var may still be set
}

if (!token) {
	console.error("No token configured for the live test.");
	console.error("Copy test/config.example.js to test/config.js and fill in your bot token, or set CS_TEST_TOKEN.");
	process.exit(1);
}

// If a connection wedges the event loop, this still ends the run. unref'd, so a clean finish exits naturally sooner.
const watchdog = setTimeout(() => {
	console.error("live test watchdog fired after 120s - forcing exit");
	process.exit(1);
}, 120000);
watchdog.unref();

const { PresenceUpdateStatus } = require("discord-api-types/v10");

const { Client } = require("../dist/index.js");
const { waitFor } = require("./mockgateway.js");

/** @type {Array<[string, import("../dist").IClientWSOptions]>} */
const testConfigs = [
	["json+zlib", { encoding: "json", compress: true }],
	["etf+zlib", { encoding: "etf", compress: true }]
];

for (const [name, ws] of testConfigs) {
	test(`live gateway: connect, presence, forced resume, graceful close (${name})`, async t => {
		const client = new Client(token, { intents: ["GUILDS"], ws: { ...ws, connectThrottle: 100 } });
		client.on("error", () => void 0); // gateway notices during the forced resume are expected and not failures
		t.after(() => client.disconnect());

		await client.connect();
		await waitFor(client, "ready", 30000);
		const shard = client.shardManager.shards[0];
		assert.equal(shard.connector.status, "ready");
		assert.ok(shard.connector.sessionId, "READY must carry a session id");
		assert.ok(shard.connector.resumeAddress, "READY must carry a resume gateway url");

		await client.presenceUpdate({ status: PresenceUpdateStatus.Online, activities: [{ name: "CloudStorm live test", type: 0 }] });

		// Force a resumable close and expect Discord to continue the session, not start a new one
		const sessionBefore = shard.connector.sessionId;
		const resumeP = waitFor(client, "shardReady", 25000, "shardReady after forced resume");
		shard.connector["_reconnect"](true);
		const [readyInfo] = await resumeP;
		assert.equal(readyInfo.ready, false, "shardReady.ready=false marks a resume");
		assert.equal(shard.connector.sessionId, sessionBefore, "the session must survive the resume");

		// A graceful close should complete via Discord's close echo, well inside the 5s no-response fallback
		const closeStarted = Date.now();
		const disconnectedP = waitFor(client, "disconnected", 10000);
		client.disconnect();
		await disconnectedP;
		assert.ok(Date.now() - closeStarted < 4500, "the close should be acknowledged by the server, not time out locally");
	});
}
