"use strict";

// @ts-check

// A minimal in-process Discord-gateway stand-in: a real HTTP server performing real WebSocket
// upgrades and speaking raw frames over the socket, scripted per test. Client-to-server frames
// arrive masked (CloudStorm always masks with a zero key); server-to-client frames are unmasked.
//
// Note: scenario scripts usually write HELLO within the same tick window as the 101 response,
// so both coalesce into one TCP segment. That is deliberate - it exercises the client's handling
// of the upgrade `head` buffer, which real Discord also hits because it sends HELLO immediately.

const http = require("node:http");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");

const { DiscordConnector } = require("../dist/index.js");

const WS_KEY_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * @param {import("stream").Duplex} socket
 */
function makeConn(socket) {
	/**
	 * @type {EventEmitter & {
	 * 	socket: import("stream").Duplex;
	 * 	sendRaw: (opcode: number, data: Buffer) => void;
	 * 	sendJSON: (obj: any) => void;
	 * 	sendClose: (code: number) => void;
	 * 	ackCloses: () => void;
	 * }}
	 */
	// @ts-expect-error Trust
	const conn = new EventEmitter();
	conn.socket = socket;
	let buf = Buffer.alloc(0);
	socket.on("data", d => {
		buf = Buffer.concat([buf, d]);
		for (;;) {
			if (buf.length < 2) return;
			const opcode = buf[0] & 15;
			const masked = (buf[1] & 128) !== 0;
			let len = buf[1] & 127;
			let off = 2;
			if (len === 126) {
				if (buf.length < 4) return;
				len = buf.readUInt16BE(2);
				off = 4;
			} else if (len === 127) {
				if (buf.length < 10) return;
				len = Number(buf.readBigUInt64BE(2));
				off = 10;
			}
			let mask = null;
			if (masked) {
				if (buf.length < off + 4) return;
				mask = buf.subarray(off, off + 4);
				off += 4;
			}
			if (buf.length < off + len) return;
			const payload = Buffer.from(buf.subarray(off, off + len));
			if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
			buf = buf.subarray(off + len);
			conn.emit("frame", opcode, payload);
			if (opcode === 1) conn.emit("message", JSON.parse(payload.toString()));
			if (opcode === 8) conn.emit("closeframe", payload.length >= 2 ? payload.readUInt16BE(0) : null);
		}
	});
	socket.on("error", () => void 0);
	conn.sendRaw = (opcode, payload) => {
		let header;
		if (payload.length < 126) header = Buffer.from([128 + opcode, payload.length]);
		else if (payload.length < 65536) {
			header = Buffer.alloc(4);
			header[0] = 128 + opcode;
			header[1] = 126;
			header.writeUInt16BE(payload.length, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 128 + opcode;
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(payload.length), 2);
		}
		socket.write(Buffer.concat([header, payload]));
	};
	conn.sendJSON = obj => conn.sendRaw(1, Buffer.from(JSON.stringify(obj)));
	conn.sendClose = code => {
		const b = Buffer.alloc(2);
		b.writeUInt16BE(code, 0);
		conn.sendRaw(8, b);
	};
	/** Behave like Discord on a client-initiated close: echo the close frame, then hang up */
	conn.ackCloses = () => conn.on("closeframe", code => {
		conn.sendClose(code ?? 1000);
		conn.socket.end();
	});
	return conn;
}

/**
 * @typedef {EventEmitter & {
 * 	conns: Array<ReturnType<typeof makeConn>>;
 * 	server: http.Server;
 * 	close: () => void;
 * 	port?: number;
 * 	url: string;
 * }} MockGateway
 */

/**
 * Starts the mock gateway on a random port. Emits "connection" with a conn per websocket upgrade.
 * @returns {Promise<MockGateway>}
 */
function startGateway() {
	const server = http.createServer((req, res) => {
		res.writeHead(400);
		res.end();
	});
	/** @type {MockGateway} */
	// @ts-expect-error Trust
	const gw = new EventEmitter();
	gw.conns = [];
	server.on("upgrade", (req, socket) => {
		const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + WS_KEY_GUID).digest("base64");
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		const conn = makeConn(socket);
		gw.conns.push(conn);
		gw.emit("connection", conn);
	});
	gw.server = server;
	gw.close = () => {
		for (const conn of gw.conns) conn.socket.destroy();
		server.close();
	};
	return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
		const addr = server.address();
		gw.port = typeof addr === "string" ? Number(addr) : addr?.port;
		gw.url = `ws://127.0.0.1:${gw.port}/`;
		resolve(gw);
	}));
}

/**
 * Resolves with the args of the next `event`, or rejects after `ms`
 * @param {EventEmitter} emitter
 * @param {string} event
 * @returns {Promise<Array<any>>}
 */
function waitFor(emitter, event, ms = 4000, what = event) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			emitter.removeListener(event, listener);
			reject(new Error(`timeout waiting for ${what}`));
		}, ms);
		/** @param {Array<any>} args */
		const listener = (...args) => {
			clearTimeout(timer);
			resolve(args);
		};
		emitter.once(event, listener);
	});
}

/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A gateway plus a DiscordConnector wired to a fake client, torn down after the test.
 * queueIdentify is answered by identifying immediately (what ShardManager would do, minus buckets).
 * @param {import("node:test").TestContext} t
 * @param {import("../dist").IClientWSOptions} wsOverrides
 */
async function connectorEnv(t, wsOverrides = {}) {
	const gw = await startGateway();
	/** @type {import("../dist").Client & { errors: Array<Error> }} */
	// @ts-expect-error Trust
	const client = new EventEmitter();
	client.errors = [];
	client.on("error", e => client.errors.push(e));
	client.options = {
		token: "TESTTOKEN",
		endpoint: gw.url,
		intents: 0,
		largeGuildThreshold: 250,
		totalShards: 1,
		shards: "auto",
		ws: { encoding: "json", compress: false, connectThrottle: 100, ...wsOverrides }
	};
	const connector = new DiscordConnector(0, client);
	connector.on("queueIdentify", () => connector.identify());
	t.after(async () => {
		// Destroy the server side right after requesting the close: scenarios rarely ack close frames,
		// and awaiting a graceful close against a silent server would cost the 5s fallback per test
		const closed = connector.disconnect().catch(() => void 0);
		gw.close();
		await closed;
	});
	return { gw, client, connector };
}

/**
 * Drives connect -> HELLO -> IDENTIFY -> READY. Returns the server conn and the received identify payload.
 * @param {Awaited<ReturnType<typeof connectorEnv>>} env
 */
async function connectAndReady(env, heartbeatInterval = 45000) {
	const connP = waitFor(env.gw, "connection");
	env.connector.connect();
	/** @type {[ReturnType<typeof makeConn>]} */
	// @ts-expect-error Trust
	const [conn] = await connP;
	const identifyP = waitFor(conn, "message");
	conn.sendJSON({ op: 10, d: { heartbeat_interval: heartbeatInterval } });
	const [identify] = await identifyP;
	const readyP = waitFor(env.connector, "ready");
	conn.sendJSON({ op: 0, t: "READY", s: 1, d: { session_id: "sess-test", resume_gateway_url: `ws://127.0.0.1:${env.gw.port}`, user: {}, guilds: [] } });
	await readyP;
	return { conn, identify };
}

module.exports = { startGateway, waitFor, sleep, connectorEnv, connectAndReady };
