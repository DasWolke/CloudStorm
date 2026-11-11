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
	console.error("live test watchdog fired after 240s - forcing exit");
	process.exit(1);
}, 240000);
watchdog.unref();

const { setTimeout: sleep } = require("node:timers/promises");
const { PresenceUpdateStatus } = require("discord-api-types/v10");
const { SnowTransfer } = require("snowtransfer");

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

test("live gateway: etf hands back real Discord payloads the same as json", { timeout: 180000 }, async t => {
	// One rest client for every connect so /gateway/bot calls share a bucket. The tests before this one just used it up
	const rest = new SnowTransfer(token, { retryRequests: true });
	const { shards } = await rest.bot.getGatewayBot();
	const json = await captureGuilds(rest, "json", shards);
	const etf = await captureGuilds(rest, "etf", shards);

	/** @type {{ kinds: Set<string>, keys: Set<string>, values: Map<string, { count: number, json: string, etf: string }> }} */
	const out = { kinds: new Set(), keys: new Set(), values: new Map() };
	// READY carries per-session values (session_id, resume url, _trace), so only its shape is compared
	diffPayloads(json.ready, etf.ready, "READY", out, false);
	let compared = 0;
	for (const [id, guild] of json.guilds) {
		const other = etf.guilds.get(id);
		if (!other) continue;
		diffPayloads(guild, other, "GUILD_CREATE", out, true);
		compared++;
	}
	t.diagnostic(`shard 0/${shards}: compared READY and ${compared} GUILD_CREATEs (READY listed ${json.ready.guilds.length}, json got ${json.guilds.size}, etf got ${etf.guilds.size})`);
	assert.ok(compared > 0, "both encodings must have received guilds to compare");
	assert.deepEqual([...out.kinds], [], "fields decoded as a different type");
	assert.deepEqual([...out.keys], [], "fields present in only one encoding");
	assert.deepEqual(Object.fromEntries(out.values), {}, "string/boolean values that differ");
});

/**
 * Connect shard 0 alone and collect READY plus the GUILD_CREATE burst that follows it.
 * @param {SnowTransfer} rest
 * @param {"json" | "etf"} encoding
 * @param {number} totalShards
 */
async function captureGuilds(rest, encoding, totalShards) {
	const client = new Client(token, { snowtransferInstance: rest, intents: ["GUILDS"], shards: [0], totalShards, ws: { encoding, compress: true } });
	client.on("error", () => void 0);
	/** @type {any} */
	let ready = null;
	/** @type {Map<string, any>} */
	const guilds = new Map();
	let lastAt = Date.now();
	client.on("dispatch", msg => {
		if (msg.t === "READY") ready = msg.d;
		else if (msg.t === "GUILD_CREATE") guilds.set(msg.d.id, msg.d);
		lastAt = Date.now();
	});
	await client.connect();
	await waitFor(client, "ready", 30000);
	// Done once every guild from READY arrived, or the stream went quiet (unavailable guilds never arrive)
	const started = Date.now();
	while (guilds.size < ready.guilds.length && Date.now() - lastAt < 5000 && Date.now() - started < 60000) {
		await sleep(250);
	}
	const disconnectedP = waitFor(client, "disconnected", 10000);
	client.disconnect();
	await disconnectedP;
	return { ready, guilds };
}

// Move with chat activity in the seconds between the json and etf sessions, so they can't be compared
const volatileKeys = new Set(["last_message_id", "last_pin_timestamp"]);

/** @param {any} value */
function kindOf(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/**
 * Walk a json and an etf decode of the same payload and record every difference by path.
 * Arrays of objects with ids are matched by id since order and membership may shift between the two sessions.
 * @param {any} a json value
 * @param {any} b etf value
 * @param {string} path
 * @param {{ kinds: Set<string>, keys: Set<string>, values: Map<string, { count: number, json: string, etf: string }> }} out
 * @param {boolean} values whether string/boolean values must match too
 */
function diffPayloads(a, b, path, out, values) {
	const ka = kindOf(a);
	const kb = kindOf(b);
	if (ka !== kb) {
		out.kinds.add(`${path}: json ${ka}, etf ${kb}`);
		return;
	}
	if (ka === "array") {
		if ([...a, ...b].every(x => kindOf(x) === "object" && typeof x.id === "string")) {
			const byId = new Map(b.map((/** @type {any} */ x) => [x.id, x]));
			for (const x of a) {
				if (byId.has(x.id)) diffPayloads(x, byId.get(x.id), `${path}[]`, out, values);
			}
		} else {
			for (let i = 0; i < Math.min(a.length, b.length); i++) {
				diffPayloads(a[i], b[i], `${path}[]`, out, values);
			}
		}
	} else if (ka === "object") {
		for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
			if (volatileKeys.has(key)) continue;
			const p = `${path}.${/^\d{15,}$/.test(key) ? "<id>" : key}`;
			if (!(key in a)) out.keys.add(`${p}: only in etf`);
			else if (!(key in b)) out.keys.add(`${p}: only in json`);
			else diffPayloads(a[key], b[key], p, out, values);
		}
	} else if (values && (ka === "string" || ka === "boolean") && a !== b) {
		const entry = out.values.get(path) ?? { count: 0, json: JSON.stringify(a).slice(0, 80), etf: JSON.stringify(b).slice(0, 80) };
		entry.count++;
		out.values.set(path, entry);
	}
}
