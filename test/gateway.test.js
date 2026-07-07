"use strict";

// @ts-check

// Tests pin CloudStorm's gateway behavior against a scripted mock server (see mockgateway.js).
// The scenarios encode what we believe Discord does on the wire. If Discord's real behavior is
// ever observed to differ, update the scenario here to match reality - the mock is the contract.
// Each test names the failure it guards against; none of them merely echo mock data back.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const path = require("node:path");

const { PresenceUpdateStatus } = require("discord-api-types/v10");

const { BetterWs, Client, DiscordConnector, Shard, ShardManager } = require("../dist/index.js");
const { startGateway, waitFor, sleep, connectorEnv, connectAndReady } = require("./mockgateway.js");

/**
 * @template {Array<any>} T
 * @typedef {T extends Array<infer R> ? R : never} UnpackArray
 */

test("connects through a coalesced 101+HELLO, identifies and becomes ready", async t => {
	// The mock writes HELLO in the same segment as the 101 response, like Discord does.
	// Dropping the upgrade head buffer would hang this test at the identify wait.
	const env = await connectorEnv(t);
	const { identify } = await connectAndReady(env);
	assert.equal(identify.op, 2);
	assert.equal(identify.d.token, "TESTTOKEN");
	assert.deepEqual(identify.d.shard, [0, 1]);
	assert.equal(env.connector.status, "ready");
	assert.equal(env.connector.sm.currentStateName, "ready");
	assert.equal(env.connector.seq, 1);
	assert.equal(env.connector.sessionId, "sess-test");
	assert.ok(env.connector.resumeAddress?.startsWith(`ws://127.0.0.1:${env.gw.port}?v=`), "resumeAddress should be built from resume_gateway_url");
});

test("a dispatch seq gap forces a resumable close and the gapped event arrives exactly once, via the replay", async t => {
	const env = await connectorEnv(t);
	const { conn } = await connectAndReady(env);

	conn.sendJSON({ op: 0, t: "SOMETHING_CREATE", s: 2, d: {} });
	await waitFor(env.client, "dispatch");

	// The resume below makes Discord replay everything after seq 2 including s=5 itself.
	// Delivering s=5 while detecting the gap would therefore hand it to the user twice.
	let gappedDeliveries = 0;
	env.client.on("dispatch", message => {
		if (message.s === 5) gappedDeliveries++;
	});

	// s=5 skips 3 and 4. Resuming with 5 would tell Discord we saw them and lose the events forever.
	const closeP = waitFor(conn, "closeframe");
	const reconnectP = waitFor(env.gw, "connection");
	conn.sendJSON({ op: 0, t: "SOMETHING_CREATE", s: 5, d: {} });
	const [closeCode] = await closeP;
	assert.equal(closeCode, 4000, "gap must close with a code Discord treats as resumable");
	conn.sendClose(closeCode);
	conn.socket.end();

	const [conn2] = await reconnectP;
	const resumeP = waitFor(conn2, "message");
	conn2.sendJSON({ op: 10, d: { heartbeat_interval: 45000 } });
	const [resume] = await resumeP;
	assert.equal(resume.op, 6);
	assert.equal(resume.d.seq, 2, "resume must carry the last seq actually processed, not the gapped one");
	assert.equal(resume.d.session_id, "sess-test");

	// Discord replays the missed events in order, then confirms the resume
	const readyP = waitFor(env.connector, "ready");
	conn2.sendJSON({ op: 0, t: "SOMETHING_CREATE", s: 3, d: {} });
	conn2.sendJSON({ op: 0, t: "SOMETHING_CREATE", s: 4, d: {} });
	conn2.sendJSON({ op: 0, t: "SOMETHING_CREATE", s: 5, d: {} });
	conn2.sendJSON({ op: 0, t: "RESUMED", s: 6, d: {} });
	const [resumed] = await readyP;
	assert.equal(resumed, true, "the ready event should mark this as a resume");
	assert.equal(env.connector.seq, 6);
	assert.equal(gappedDeliveries, 1, "the gap-triggering event must reach the user exactly once");
});

test("a malformed frame emits an error and recycles the connection instead of crashing", async t => {
	const env = await connectorEnv(t);
	const { conn } = await connectAndReady(env);

	const errorsBefore = env.client.errors.length;
	const reconnectP = waitFor(env.gw, "connection");
	conn.sendRaw(1, Buffer.from("this is not json {{{"));

	const [conn2] = await reconnectP; // a crash or a hang here means garbage on the wire took the shard down for good
	assert.ok(env.client.errors.length > errorsBefore, "the parse failure must surface as an error event");

	const resumeP = waitFor(conn2, "message");
	conn2.sendJSON({ op: 10, d: { heartbeat_interval: 45000 } });
	const [resume] = await resumeP;
	assert.equal(resume.op, 6, "the teardown looks like a 1006 to the connector, which keeps the session and resumes");
});

test("a manual disconnect sticks even when the server never acknowledges the close", async t => {
	const env = await connectorEnv(t, { connectThrottle: 50 });
	const { conn } = await connectAndReady(env);

	let newConnections = 0;
	const count = () => newConnections++;
	env.gw.on("connection", count);

	const closeP = waitFor(conn, "closeframe");
	const disconnectP = env.connector.disconnect();
	assert.equal(env.connector.sm.currentStateName, "closing");
	const [closeCode] = await closeP;
	assert.equal(closeCode, 1000);
	// Deliberately never answer: the connector falls back to ws_close(1006) after its 5s timer,
	// and 1006 being a resumable code must NOT override the user's intent to disconnect.
	await disconnectP;
	await sleep(500); // with connectThrottle=50 a wrongly-scheduled reconnect would land in this window
	env.gw.removeListener("connection", count);

	assert.equal(newConnections, 0, "a manual close must never auto-reconnect");
	assert.equal(env.connector.status, "disconnected");
	assert.equal(env.connector.sm.currentStateName, "disconnected");
});

test("disconnect cancels a connect attempt that has not finished upgrading", async t => {
	const env = await connectorEnv(t);

	// cancel while the upgrade request is in flight
	env.connector.connect();
	assert.equal(env.connector.betterWs.sm.currentStateName, "connecting");
	await env.connector.disconnect();
	assert.equal(env.connector.betterWs.sm.currentStateName, "disconnected");

	// cancel while waiting out the connect throttle (a pending timer that must not fire afterwards)
	env.connector.connect();
	await env.connector.disconnect();
	env.connector.connect(); // within the throttle window of the attempt above
	assert.equal(env.connector.betterWs.sm.currentStateName, "connect_wait");
	await env.connector.disconnect();
	const connectionsBefore = env.gw.conns.length;
	await sleep(400); // the throttle timer would fire ~100ms in if the cancel leaked it
	assert.equal(env.connector.betterWs.sm.currentStateName, "disconnected");
	assert.equal(env.gw.conns.length, connectionsBefore, "no connection may appear after the cancelled wait");
});

test("concurrent close() calls settle together instead of stranding the first caller", async t => {
	const env = await connectorEnv(t);
	const { conn } = await connectAndReady(env);
	conn.ackCloses();

	const first = env.connector.disconnect();
	const second = env.connector.betterWs.close(1000, "second"); // re-enters half_close and must share the close promise
	await Promise.all([
		waitFor(env.connector, "disconnect", 4000, "disconnect event"),
		first,
		second
	]);
	assert.equal(env.connector.sm.currentStateName, "disconnected");
});

test("connect() during a pending disconnect finishes the close, then reconnects", async t => {
	const env = await connectorEnv(t);
	const { conn } = await connectAndReady(env);
	conn.ackCloses();

	const reconnectP = waitFor(env.gw, "connection", 8000);
	const disconnectP = env.connector.disconnect();
	env.connector.connect(); // while the close handshake is still in flight
	assert.equal(env.connector.sm.currentStateName, "reconnecting", "connect() during closing must flip the intent");
	await disconnectP;

	const [conn2] = await reconnectP;
	const helloResponseP = waitFor(conn2, "message");
	conn2.sendJSON({ op: 10, d: { heartbeat_interval: 45000 } });
	const [message] = await helloResponseP;
	assert.ok(message.op === 2 || message.op === 6, "the shard must come back after the close completes");
});

test("OP 7 RECONNECT closes resumable and resumes the session", async t => {
	const env = await connectorEnv(t);
	const { conn } = await connectAndReady(env);

	const closeP = waitFor(conn, "closeframe");
	const reconnectP = waitFor(env.gw, "connection");
	conn.sendJSON({ op: 7, d: null });
	const [closeCode] = await closeP;
	assert.equal(closeCode, 4000);
	conn.sendClose(closeCode);
	conn.socket.end();

	const [conn2] = await reconnectP;
	const resumeP = waitFor(conn2, "message");
	conn2.sendJSON({ op: 10, d: { heartbeat_interval: 45000 } });
	const [resume] = await resumeP;
	assert.equal(resume.op, 6);
	assert.equal(resume.d.session_id, "sess-test");
});

test("INVALID_SESSION d=false discards the session and identifies fresh on the same connection", async t => {
	const env = await connectorEnv(t);
	const { conn } = await connectAndReady(env);

	const reidentifyP = waitFor(conn, "message");
	conn.sendJSON({ op: 9, d: false });
	const [reidentify] = await reidentifyP;
	assert.equal(reidentify.op, 2, "an unresumable session must lead to a new IDENTIFY, not a RESUME");
	assert.equal(env.connector.sessionId, null);
	assert.equal(env.connector.seq, 0);
});

test("an OP 1 heartbeat request is answered immediately with the current sequence", async t => {
	const env = await connectorEnv(t);
	const { conn } = await connectAndReady(env);

	const heartbeatP = waitFor(conn, "message");
	conn.sendJSON({ op: 1, d: null });
	const [heartbeat] = await heartbeatP;
	assert.equal(heartbeat.op, 1);
	assert.equal(heartbeat.d, 1, "the heartbeat must report the last processed seq");
});

test("ETF payloads larger than the initial write buffer arrive whole", async t => {
	// writeETF starts with a 4KB buffer; payloads past it used to be silently truncated into
	// corrupt frames (or throw), surfacing as mysterious 4002 closes from Discord.
	const gw = await startGateway();
	const ws = new BetterWs(gw.url, { encoding: "etf", compress: false, connectThrottle: 50 });
	ws.on("error", () => void 0); // teardown resets are irrelevant to this test
	t.after(async () => {
		const closed = ws.close(1000).catch(() => void 0);
		gw.close();
		await closed;
	});
	const connP = waitFor(gw, "connection");
	ws.connect();
	const [conn] = await connP;
	await waitFor(ws, "ws_open");

	/** @type {Promise<[number, Buffer]>} */
	// @ts-expect-error Trust
	const frameP = waitFor(conn, "frame");
	ws.sendMessage({ op: 1, d: "x".repeat(8000) });
	const [opcode, payload] = await frameP;
	assert.equal(opcode, 2, "etf frames are binary");
	assert.equal(payload[0], 131, "etf payloads start with the version byte");
	const xBytes = payload.filter(b => b === 120).length;
	assert.ok(xBytes >= 8000, `all 8000 payload bytes must survive, found ${xBytes}`);
});

test("ETF encode and decode agree through a real socket", async t => {
	// Pins the encoder/decoder contract, including the parts that are NOT identity:
	// integers beyond int32 and bigints decode as strings (how snowflakes stay precise).
	const gw = await startGateway();
	const ws = new BetterWs(gw.url, { encoding: "etf", compress: false, connectThrottle: 50 });
	ws.on("error", () => void 0); // teardown resets are irrelevant to this test
	t.after(async () => {
		const closed = ws.close(1000).catch(() => void 0);
		gw.close();
		await closed;
	});
	const connP = waitFor(gw, "connection");
	ws.connect();
	/** @type {[UnpackArray<import("./mockgateway.js").MockGateway["conns"]>]} */
	// @ts-expect-error Trust
	const [conn] = await connP;
	await waitFor(ws, "ws_open");
	conn.on("frame",
		/**
		 * @param {number} opcode
		 * @param {Buffer} payload
		 */
		(opcode, payload) => conn.sendRaw(opcode, payload)); // echo the raw etf bytes back

	const receiveP = waitFor(ws, "ws_receive");
	ws.sendMessage({
		op: 3,
		d: {
			content: "héllo 世界 🎉",
			flag: true,
			off: false,
			nothing: null,
			float: 2.5,
			int: -1234,
			big_int: 1099511627776,
			snowflake: 378773803225841668n,
			negative_big: -5n,
			list: [1, "two", false],
			nested: { deep: "value" },
			dropped: undefined,
			dropped_fn: () => void 0,
			// A skipped array element would desync the decoder from the list's length prefix,
			// corrupting everything in the payload after it - not just this list
			sparse_list: [1, undefined, () => void 0, 2],
			after_the_list: "must survive"
		}
	});
	const [packet] = await receiveP;
	assert.deepEqual(packet, {
		op: 3,
		d: {
			content: "héllo 世界 🎉",
			flag: true,
			off: false,
			nothing: null,
			float: 2.5,
			int: -1234,
			big_int: "1099511627776",
			snowflake: "378773803225841668",
			negative_big: "-5",
			list: [1, "two", false],
			nested: { deep: "value" },
			// `dropped`/`dropped_fn` are omitted entirely and unencodable array elements
			// become null, like JSON.stringify would
			sparse_list: [1, null, null, 2],
			after_the_list: "must survive"
		}
	});
});

test("a socket error on a BetterWs without error listeners still completes the teardown", async t => {
	// emit("error") with zero listeners throws by EventEmitter contract. If that throw escapes inside the
	// error transition, the machine wedges: state says disconnected but onEnter (close resolution, socket
	// cleanup, timer cancellation) never ran. Deliberately NO error listener here.
	const gw = await startGateway();
	const ws = new BetterWs(gw.url, { encoding: "json", compress: false, connectThrottle: 50 });
	t.after(() => gw.close());

	const connP = waitFor(gw, "connection");
	ws.connect();
	/** @type {[UnpackArray<import("./mockgateway.js").MockGateway["conns"]>]} */
	// @ts-expect-error Trust
	const [conn] = await connP;
	await waitFor(ws, "ws_open");

	const closedP = waitFor(ws, "ws_close", 4000, "ws_close after reset");
	// @ts-expect-error the method is there
	conn.socket.resetAndDestroy(); // ECONNRESET on the client -> the error transition fires with nobody listening
	const [code] = await closedP;
	assert.equal(code, 1006);
	assert.equal(ws.sm.currentStateName, "disconnected");
	await ws.close(1000); // must be an instant no-op on a fully torn down socket, not a hang
});

test("ShardManager.presenceUpdate rejects catchably when a shard is not ready", async t => {
	/** @type {import("../dist").Client} */
	// @ts-expect-error Trust
	const client = new EventEmitter();
	client.on("error", () => void 0);
	client.options = { token: "TESTTOKEN", endpoint: "ws://127.0.0.1:1/", intents: 0, largeGuildThreshold: 250, totalShards: 1, shards: "auto", ws: { encoding: "json", compress: false } };
	const manager = new ShardManager(client);
	manager.shards[0] = new Shard(0, client); // never connected

	/** @type {Array<unknown>} */
	const unhandled = [];
	/** @param {unknown} reason */
	const track = reason => unhandled.push(reason);
	process.on("unhandledRejection", track);
	t.after(() => process.removeListener("unhandledRejection", track));

	await assert.rejects(manager.presenceUpdate({ status: PresenceUpdateStatus.Online }), /not ready/);
	await sleep(30); // an unhandled rejection would surface on a later tick
	assert.deepEqual(unhandled, [], "the rejection must flow through the returned promise, not crash the process");
});

test("fetchConnectInfo applies Discord's session limits without spending an identify slot", async () => {
	/** @type {import("snowtransfer").SnowTransfer} */
	const stub = {
		// @ts-expect-error
		bot: {
			getGatewayBot: async () => ({
				url: "wss://gateway.discord.gg",
				shards: 1,
				session_start_limit: { total: 1000, remaining: 1, reset_after: 86400000, max_concurrency: 2 }
			})
		}
	};
	const client = new Client("Bot TESTTOKEN", { snowtransferInstance: stub });
	await client.fetchConnectInfo();
	// remaining: 1 means exactly one identify is still allowed today. Probing must not consume it.
	// @ts-expect-error Counter is a default interface. It's actually an IntervalCounter which does have remaining
	assert.equal(client.shardManager.identifyBucket.counters[0].remaining, 1);
	assert.equal(Object.keys(client.shardManager.concurrencyBuckets).length, 2, "one concurrency bucket per max_concurrency route");
});

test("resume data survives a process restart: export after a resumable disconnect, seed, resume without identifying", async t => {
	const gw = await startGateway();
	t.after(() => gw.close());
	/** @returns {import("snowtransfer").SnowTransfer} */
	const makeStub = () => ({
		// @ts-expect-error
		bot: {
			getGatewayBot: async () => ({
				url: gw.url,
				shards: 1,
				session_start_limit: { total: 1000, remaining: 500, reset_after: 86400000, max_concurrency: 1 }
			})
		}
	});
	const wsOptions = { encoding: "json", compress: false, connectThrottle: 50 };

	// "process 1": establish a session the normal way
	// @ts-expect-error it is a valid encoding option just js cannot cast as const
	const clientA = new Client("Bot TESTTOKEN", { snowtransferInstance: makeStub(), ws: wsOptions });
	clientA.on("error", () => void 0);
	const conn1P = waitFor(gw, "connection");
	const readyP = waitFor(clientA, "ready");
	await clientA.connect();
	/** @type {[UnpackArray<import("./mockgateway.js").MockGateway["conns"]>]} */
	// @ts-expect-error Trust
	const [conn1] = await conn1P;
	const identifyP = waitFor(conn1, "message");
	conn1.sendJSON({ op: 10, d: { heartbeat_interval: 45000 } });
	const [identify] = await identifyP;
	assert.equal(identify.op, 2, "a fresh client identifies");
	conn1.sendJSON({ op: 0, t: "READY", s: 1, d: { session_id: "sess-restart", resume_gateway_url: `ws://127.0.0.1:${gw.port}`, user: {}, guilds: [] } });
	await readyP;

	// shut down with the session kept alive: the close code must not be the session-destroying 1000
	conn1.ackCloses();
	const closeP = waitFor(conn1, "closeframe");
	const disconnectedP = waitFor(clientA, "disconnected", 4000, "client disconnected event");
	clientA.disconnect(true);
	const [closeCode] = await closeP;
	assert.notEqual(closeCode, 1000, "a resumable shutdown must not close with 1000");
	await disconnectedP;

	const resumeData = JSON.parse(JSON.stringify(clientA.getResumeData())); // simulate the write-to-file round trip
	assert.deepEqual(resumeData, {
		0: { sessionId: "sess-restart", seq: 1, resumeAddress: `ws://127.0.0.1:${gw.port}?v=10&encoding=json` }
	});

	// "process 2": a brand new client seeded with the exported data
	// @ts-expect-error it is a valid encoding option just js cannot cast as const
	const clientB = new Client("Bot TESTTOKEN", { snowtransferInstance: makeStub(), resumeData, ws: wsOptions });
	clientB.on("error", () => void 0);
	t.after(() => {
		clientB.disconnect(); // the gw teardown right after resolves the close immediately
	});
	const conn2P = waitFor(gw, "connection");
	const shardReadyP = waitFor(clientB, "shardReady");
	await clientB.connect();
	/** @type {[UnpackArray<import("./mockgateway.js").MockGateway["conns"]>]} */
	// @ts-expect-error Trust
	const [conn2] = await conn2P;
	const resumeP = waitFor(conn2, "message");
	conn2.sendJSON({ op: 10, d: { heartbeat_interval: 45000 } });
	const [resume] = await resumeP;
	assert.equal(resume.op, 6, "a seeded client must resume, never identify");
	assert.equal(resume.d.session_id, "sess-restart");
	assert.equal(resume.d.seq, 1, "the resume must continue from the exported seq");
	conn2.sendJSON({ op: 0, t: "RESUMED", s: 2, d: {} });
	const [shardReady] = await shardReadyP;
	assert.equal(shardReady.ready, false, "the shard comes back via resume");
	// @ts-expect-error Counter is a default interface. It's actually an IntervalCounter which does have remaining
	assert.equal(clientB.shardManager.identifyBucket.counters[0].remaining, 500, "resuming must not consume an identify slot");
});

test("a READY that crosses a deliberate close is recorded but does not resurrect the connection", async t => {
	const env = await connectorEnv(t);
	const { conn } = await connectAndReady(env);

	// op 7: the lib closes resumable and will reconnect. Discord's next payload races that close on the wire.
	const closeP = waitFor(conn, "closeframe");
	conn.sendJSON({ op: 7, d: null });
	await closeP;
	assert.equal(env.connector.sm.currentStateName, "reconnecting");

	/** @type {Array<boolean>} */
	const readyEvents = [];
	env.connector.on("ready", resume => readyEvents.push(resume));
	const errorsBefore = env.client.errors.length;
	conn.sendJSON({ op: 0, t: "READY", s: 2, d: { session_id: "sess-crossed", resume_gateway_url: `ws://127.0.0.1:${env.gw.port}`, user: {}, guilds: [] } });
	await sleep(50);
	assert.deepEqual(env.client.errors.slice(errorsBefore), [], "a crossing READY must not surface an internal error");
	assert.deepEqual(readyEvents, [], "the shard must not announce ready while tearing down");
	assert.equal(env.connector.sessionId, "sess-crossed", "the crossed READY's session is the freshest one a later resume can target");

	// completing the close must still reconnect and resume the session the crossing READY delivered
	const reconnectP = waitFor(env.gw, "connection", 8000);
	conn.sendClose(4000);
	conn.socket.end();
	/** @type {[UnpackArray<import("./mockgateway.js").MockGateway["conns"]>]} */
	// @ts-expect-error Trust
	const [conn2] = await reconnectP;
	const resumeP = waitFor(conn2, "message");
	conn2.sendJSON({ op: 10, d: { heartbeat_interval: 45000 } });
	const [resume] = await resumeP;
	assert.equal(resume.op, 6);
	assert.equal(resume.d.session_id, "sess-crossed");
});

test("a stale queued identify from before a reconnect never double-identifies the new connection", async t => {
	// Two queueIdentify events can be waiting in ShardManager's identify bucket for the same shard when a
	// connection dies while the first is still queued. Both eventually run against the replacement
	// connection, and a second IDENTIFY there gets the fresh session closed with a 4005.
	const env = await connectorEnv(t);
	env.connector.removeAllListeners("queueIdentify"); // replace the auto-identify with a "busy bucket"
	/** @type {Array<() => Promise<void>>} */
	const queuedJobs = [];
	env.connector.on("queueIdentify", () => queuedJobs.push(() => env.connector.identify()));

	// connection 1: HELLO queues an identify that never gets to run
	const conn1P = waitFor(env.gw, "connection");
	env.connector.connect();
	/** @type {[UnpackArray<import("./mockgateway.js").MockGateway["conns"]>]} */
	// @ts-expect-error Trust
	const [conn1] = await conn1P;
	const queued1P = waitFor(env.connector, "queueIdentify");
	conn1.sendJSON({ op: 10, d: { heartbeat_interval: 45000 } });
	await queued1P;

	// the connection dies before the queued identify ran; the reconnect queues a second one
	const conn2P = waitFor(env.gw, "connection", 8000);
	conn1.socket.destroy();
	/** @type {[UnpackArray<import("./mockgateway.js").MockGateway["conns"]>]} */
	// @ts-expect-error Trust
	const [conn2] = await conn2P;
	const queued2P = waitFor(env.connector, "queueIdentify");
	conn2.sendJSON({ op: 10, d: { heartbeat_interval: 45000 } });
	await queued2P;
	assert.equal(queuedJobs.length, 2);

	/** @type {Array<any>} */
	const identifies = [];
	conn2.on("message", message => {
		if (message.op === 2) identifies.push(message);
	});
	for (const job of queuedJobs) job();
	await sleep(100); // let the frames cross the socket
	assert.equal(identifies.length, 1, "exactly one IDENTIFY may go out per connection");
});

test("close() called from inside a ws_open listener still resolves only once fully closed", async t => {
	// ws_open is emitted from within a state transition, so a close() requested there has its
	// user_close transition queued. The returned promise must still track the actual teardown.
	const gw = await startGateway();
	t.after(() => gw.close());
	const ws = new BetterWs(gw.url, { encoding: "json", compress: false, connectThrottle: 50 });
	ws.on("error", () => void 0);

	/** @type {Promise<void> | undefined} */
	let closeReturn;
	ws.on("ws_open", () => {
		closeReturn = ws.close(1000, "closing from ws_open");
	});
	const connP = waitFor(gw, "connection");
	ws.connect();
	/** @type {[UnpackArray<import("./mockgateway.js").MockGateway["conns"]>]} */
	// @ts-expect-error Trust
	const [conn] = await connP;
	conn.ackCloses();
	await waitFor(conn, "closeframe");
	await closeReturn;
	assert.equal(ws.sm.currentStateName, "disconnected", "close() must not settle while the close handshake is still in flight");
});

test("a throwing dispatch listener on a client with no error listener does not crash the process", async t => {
	// A throw from a user listener must neither crash the process nor escape into the socket read loop,
	// where it reads as malformed wire data and costs the connection. Deliberately NO client error listener here.
	const gw = await startGateway();
	/** @type {import("../dist").Client} */
	// @ts-expect-error Trust
	const client = new EventEmitter();
	client.options = {
		token: "TESTTOKEN",
		endpoint: gw.url,
		intents: 0,
		largeGuildThreshold: 250,
		totalShards: 1,
		shards: "auto",
		ws: { encoding: "json", compress: false, connectThrottle: 100 }
	};
	const connector = new DiscordConnector(0, client);
	connector.on("queueIdentify", () => connector.identify());
	t.after(async () => {
		const closed = connector.disconnect().catch(() => void 0);
		gw.close();
		await closed;
	});

	const connP = waitFor(gw, "connection");
	connector.connect();
	/** @type {[UnpackArray<import("./mockgateway.js").MockGateway["conns"]>]} */
	// @ts-expect-error Trust
	const [conn] = await connP;
	const identifyP = waitFor(conn, "message");
	conn.sendJSON({ op: 10, d: { heartbeat_interval: 45000 } });
	await identifyP;
	const readyP = waitFor(connector, "ready");
	conn.sendJSON({ op: 0, t: "READY", s: 1, d: { session_id: "sess-test", resume_gateway_url: gw.url, user: {}, guilds: [] } });
	await readyP;

	/** @type {Array<unknown>} */
	const unhandled = [];
	/** @param {unknown} reason */
	const track = reason => unhandled.push(reason);
	process.on("unhandledRejection", track);
	t.after(() => process.removeListener("unhandledRejection", track));

	client.once("dispatch", () => {
		throw new Error("user listener exploded");
	});
	conn.sendJSON({ op: 0, t: "SOMETHING_CREATE", s: 2, d: {} });
	await sleep(50);
	assert.deepEqual(unhandled, [], "a throwing user listener must never float as an unhandled rejection");

	const aliveP = waitFor(client, "dispatch");
	conn.sendJSON({ op: 0, t: "SOMETHING_CREATE", s: 3, d: {} });
	await aliveP;
	assert.equal(connector.seq, 3, "the shard must keep processing events after the user listener threw");
});

test("payload check methods fill defaults into the sent payload without mutating the caller's objects", async t => {
	const env = await connectorEnv(t);
	const { conn } = await connectAndReady(env);

	// one activity that needs fixing up (custom status without a name) and one that gets dropped (nameless non-custom)
	const presence = { activities: [{ state: "vibing", type: 4 }, { url: "https://twitch.tv/x" }] };
	const presenceSnapshot = structuredClone(presence);
	const presenceFrameP = waitFor(conn, "message");
	// @ts-expect-error the whole point is passing partial data
	await env.connector.presenceUpdate(presence);
	const [sentPresence] = await presenceFrameP;
	assert.deepEqual(presence, presenceSnapshot, "presence input must remain reusable");
	assert.deepEqual(sentPresence.d, {
		status: "online",
		activities: [{ state: "vibing", type: 4, name: "Custom Status" }],
		afk: false,
		since: null
	});

	const voice = { guild_id: "1" };
	const voiceSnapshot = structuredClone(voice);
	const voiceFrameP = waitFor(conn, "message");
	// @ts-expect-error the whole point is passing partial data
	await env.connector.voiceStateUpdate(voice);
	const [sentVoice] = await voiceFrameP;
	assert.deepEqual(voice, voiceSnapshot, "voice state input must remain reusable");
	assert.deepEqual(sentVoice.d, { guild_id: "1", channel_id: null, self_mute: false, self_deaf: false });

	const members = { guild_id: "1", query: "a", user_ids: ["2"] };
	const membersSnapshot = structuredClone(members);
	const membersFrameP = waitFor(conn, "message");
	await env.connector.requestGuildMembers(members);
	const [sentMembers] = await membersFrameP;
	assert.deepEqual(members, membersSnapshot, "request guild members input must remain reusable");
	assert.deepEqual(sentMembers.d, { guild_id: "1", user_ids: ["2"], limit: 10 }, "user_ids wins over query in the sent payload");
});

test("a fatal close code always reaches a human: error event when listened, loud crash when not", async t => {
	// 4004 and friends leave a permanently dead shard that only a human can fix

	// with any error listener at all (a bare console.error suffices) it arrives as an error event
	const env = await connectorEnv(t);
	const { conn } = await connectAndReady(env);
	const errorP = waitFor(env.client, "error");
	conn.sendClose(4004);
	conn.socket.end();
	const [error] = await errorP;
	assert.match(error.message, /invalid token/);
	const connectionsBefore = env.gw.conns.length;
	await sleep(300); // past the 100ms connect throttle, where a wrongly-scheduled reconnect would land
	assert.equal(env.gw.conns.length, connectionsBefore, "4004 must never reconnect");

	// with no error listener the process must go down naming the problem instead of idling silently
	const gw2 = await startGateway();
	t.after(() => gw2.close());
	gw2.on("connection", conn2 => {
		conn2.sendClose(4004);
		conn2.socket.end();
	});
	const script = `
		const { DiscordConnector } = require(${JSON.stringify(path.join(__dirname, "../dist/index.js"))});
		const { EventEmitter } = require("node:events");
		const client = new EventEmitter();
		client.options = { token: "TESTTOKEN", endpoint: process.env.GW_URL, intents: 0, largeGuildThreshold: 250, totalShards: 1, shards: "auto", ws: { encoding: "json", compress: false, connectThrottle: 50 } };
		new DiscordConnector(0, client).connect();
	`;
	const child = spawn(process.execPath, ["-e", script], { env: { ...process.env, GW_URL: gw2.url } });
	t.after(() => child.kill());
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const [exitCode] = await waitFor(child, "exit", 8000, "child process exit");
	assert.notEqual(exitCode, 0, "the process must crash, not keep running with a dead shard");
	assert.match(stderr, /invalid token/i, "the crash output must name the actual problem");
});

test("the Client constructor merges options without mutating the caller's object", async () => {
	const stub = { bot: { getGatewayBot: async () => ({}) } };
	/** @type {import("../dist").IClientOptions} */
	// @ts-expect-error Trust
	const userOptions = { intents: ["GUILDS"], ws: { encoding: "etf" }, snowtransferInstance: stub };
	const client = new Client("Bot TESTTOKEN", userOptions);

	assert.deepEqual(userOptions, { intents: ["GUILDS"], ws: { encoding: "etf" }, snowtransferInstance: stub }, "the caller's object must be reusable for a second client");
	// @ts-expect-error The entire point is to ensure its undefined
	assert.equal(client.options.snowtransferInstance, undefined, "the rest client must not leak onto options");
	// @ts-expect-error Its defined
	assert.equal(client.options.ws.encoding, "etf");
	// @ts-expect-error Its defined
	assert.equal(client.options.ws.compress, true, "unspecified ws options keep their defaults");
	assert.equal(client.token, "TESTTOKEN", "Client.token is the bare token");
	assert.equal(client.options.token, "Bot TESTTOKEN", "options.token keeps what the caller passed for the gateway");
});
