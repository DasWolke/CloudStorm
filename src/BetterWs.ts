// This ultra light weight WS code is a slimmed down version originally found at https://github.com/timotejroiko/tiny-discord
// Modifications and use of this code was granted for this project by the author, Timotej Roiko.
// A major thank you to Tim for better performing software.

import { EventEmitter } from "node:events";
import { randomBytes, createHash } from "node:crypto";
import { createInflate, inflateSync, constants, type Inflate } from "node:zlib";
import https = require("node:https");
import http = require("node:http");

import type { Socket } from "node:net";

import type {
	BWSEvents,
	IClientWSOptions
} from "./Types";

import { StateMachine, StateMachineGraph as stateMachineGraph, type SMTransition } from "snowtransfer";
import Constants = require("./Constants");
import eventSwitch = require("./eventSwitch");
import etf = require("./etf");

/** Fixed GUID the WebSocket spec (RFC 6455) requires for the Sec-WebSocket-Accept handshake. */
const WS_KEY_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Helper Class for simplifying the websocket connection to Discord.
 * @since 0.1.4
 */
class BetterWs extends EventEmitter<BWSEvents> {
	/** The encoding to send/receive messages to/from the server with. */
	public encoding: "etf" | "json" | "other";
	/** If the messages sent/received are compressed with zlib. */
	public compress: boolean;
	/** How much to delay repeated calls to `connect()`. */
	public connectThrottle: number;
	/** Tracks the state this WebSocket is in and what operations are allowed. */
	public sm = new StateMachine("disconnected");

	/** The raw net.Socket retrieved from upgrading the connection or null if not upgraded/closed. */
	private _socket: Socket | null = null;
	/** Code received from frame op 8 */
	private _lastCloseCode: number | null = null;
	/** Reason received from frame op 8 */
	private _lastCloseReason: string | null = null;
	/** A promise that resolves when the connection is fully closed or null if not closing the connection if any. */
	private _closePromise: Promise<void> | null = null;
	private _closeResolver: ((value: void | PromiseLike<void>) => void) | null = null;
	/** A zlib Inflate instance if messages sent/received are going to be compressed. Auto created on connect. */
	private _zlib: Inflate | null = null;
	/** Stores when the last connection attempt was made, in order to limit reconnection loops. */
	private lastConnectAttempt = 0;
	/** The in-flight upgrade request if currently connecting. Kept so a cancelled connect can abort it. */
	private _req: http.ClientRequest | null = null;

	/**
	 * Creates a new lightweight WebSocket.
	 * @param address The http(s):// or ws(s):// URL corresponding to the server to connect to.
	 * @param options Options specific to this WebSocket.
	 */
	public constructor(public address: string, public options: Omit<IClientWSOptions, "encoding"> & { encoding?: IClientWSOptions["encoding"] | "other" }) {
		super();

		this.encoding = options.encoding ?? "other";
		this.compress = options.compress ?? false;
		this.connectThrottle = options.connectThrottle ?? 10e3;

		// user_close from a state without an established connection: no close handshake possible, just record why and land in disconnected
		const cancelConnect: SMTransition = {
			destination: "disconnected",
			onTransition: [
				(code?: number, reason?: string) => {
					this._lastCloseCode = code ?? 1000;
					this._lastCloseReason = reason ?? "Connect cancelled";
				}
			]
		};

		this.sm.defineState("connect_wait", {
			onEnter: [
				() => {
					const time = this.lastConnectAttempt - Date.now() + this.connectThrottle;
					if (time > 0) this.sm.doTransitionLater("connect_allowed", time);
					else this.sm.doTransition("connect_allowed");
				}
			],
			onLeave: [
				() => {
					this.lastConnectAttempt = Date.now();
				}
			],
			transitions: new Map([
				["connect_allowed", {
					destination: "connecting"
				}],
				["user_close", cancelConnect]
			])
		});

		this.sm.defineState("connecting", {
			onEnter: [
				() => {
					const { req, key } = createReq(this.address, this.options.headers);
					this._req = req;
					// node docs lie about destroyed requests not emitting errors after the fact, so this handler is necessary, but will be removed when req is GC swept
					req.on("error", e => this.emit("debug", `Late request error: ${e.message}`));
					this.emit("debug", "Socket sending request to upgrade");
					eventSwitch(req, {
						upgrade: (res: http.IncomingMessage, socket: Socket, head: Buffer) => {
							if (this.sm.currentStateName !== "connecting") return void socket.destroy(); // connect was cancelled while the upgrade was in flight. Don't adopt (and leak) the socket
							const hash = createHash("sha1").update(key + WS_KEY_GUID).digest("base64");
							const accept = res.headers["sec-websocket-accept"];
							if (hash !== accept) {
								socket.on("error", () => void 0);
								socket.end();
								return this.sm.doTransition("error", new Error(`Failed websocket-key validation: expected: ${hash} | received: ${accept}`));
							}
							this.sm.doTransition("upgrade", res, socket, head);
						},
						error: e => {
							throw e;
						},
						response: (res: http.ServerResponse) => {
							req.destroy();
							throw new Error(`Expected HTTP 101 Upgrade, but got ${res.statusCode} ${res.statusMessage}`);
						}
					}, AbortSignal.timeout(15000)).catch(error => {
						// The switch can settle after this connect attempt was cancelled or already failed. Only an in-flight connect may act on it.
						if (this.sm.currentStateName === "connecting") this.sm.doTransition("error", error);
					});
				}
			],
			onLeave: [],
			transitions: new Map([
				["upgrade", {
					destination: "connected",
					onTransition: [
						(res: http.IncomingMessage, socket: Socket, head: Buffer) => {
							this._req = null;
							this._socket = socket;
							if (this.compress) {
								const z = createInflate();
								// @ts-ignore
								z._c = z.close; z._h = z._handle; z._hc = z._handle.close; z._v = () => void 0;
								this._zlib = z;
							}
							this.emit("upgrade", res.headers);

							this._socket.once("close", () => this.sm.doTransition("disconnect"));
							this._socket.on("error", e => this.sm.doTransition("error", e));
							this._socket.on("readable", this._onReadable.bind(this));
							// Frames the server sent in the same segment as the 101 response arrive in head, not on the socket.
							// Discord sends HELLO immediately, so dropping head can eat the first frame(s) and hang the connection.
							if (head?.length) socket.unshift(head);
							this.emit("ws_open");
						}
					]
				}],
				["user_close", cancelConnect]
			])
		});

		this.sm.defineState("connected", {
			onEnter: [],
			onLeave: [],
			transitions: new Map([
				["disconnect", { destination: "disconnected" }],
				["user_close", {
					destination: "half_close",
					onTransition: [
						(code: number, reason?: string) => {
							this.emit("debug", "User requested socket close");

							// Ask Discord to disconnect us
							const from = Buffer.from([code >> 8, code & 255]);
							this._write(reason ? Buffer.concat([from, Buffer.from(reason)]) : from, 8);
						}
					]
				}]
			])
		});

		this.sm.defineState("half_close", {
			onEnter: [
				() => {
					this.sm.doTransitionLater("close_no_response", 5000);
				}
			],
			onLeave: [],
			transitions: new Map([
				["user_close", {
					destination: "half_close"
				}],
				["close_no_response", {
					destination: "disconnected",
					onTransition: [
						() => {
							this.emit("debug", "Server didn't respond for a full close in time");
						}
					]
				}],
				["disconnect", {
					destination: "disconnected"
				}]
			])
		});

		this.sm.defineState("disconnected", {
			onEnter: [
				() => {
					if (this._closeResolver) this._closeResolver();
					this._closeResolver = null;
					this._closePromise = null;
					if (this._zlib) {
						this._zlib.close();
						this._zlib = null;
					}
					this._req?.destroy();
					this._req = null;
					if (this._socket) {
						this._socket.destroy();
						this._socket.removeAllListeners();
						this._socket.on("error", () => void 0); // destroyed sockets can also emit late errors. With all listeners removed that would be an uncaughtException
						this._socket = null;
					}
					this.emit("ws_close", this._lastCloseCode ?? 1006, this._lastCloseReason ?? "Abnormal Closure");
					this._lastCloseCode = null;
					this._lastCloseReason = null;
				}
			],
			onLeave: [],
			transitions: new Map([
				["user_connect", { destination: "connect_wait" }]
			])
		});

		this.sm.defineUniversalTransition("error", "disconnected", (error?: Error) => {
			if (error) this._emitError(error);
		});

		this.sm.freeze();

		if (process.argv.includes("--state-machine-graph-betterws")) {
			console.log(stateMachineGraph.graph(this.sm));
		}
	}

	/**
	 * Connects to the server. Does nothing if not fully disconnected.
	 * @since 0.5.0
	 */
	public connect(): void {
		if (this.sm.currentStateName !== "disconnected") return;
		this.sm.doTransition("user_connect");
	}

	/**
	 * Encodes and writes a message to the server immediately.
	 * @since 0.1.4
	 * @param data What to send to the server.
	 */
	public sendMessage(data: any): void {
		if (this.encoding === "json") this._write(Buffer.from(JSON.stringify(data)), 1);
		else if (this.encoding === "etf") this._write(etf.write(data), 2);
		else if (this.encoding === "other") this._write(Buffer.from(data), 2);
		this.emit("ws_send", data);
	}

	/**
	 * Disconnects from the server.
	 * When connected or half-closed, asks the server for a clean close and resolves once the connection is fully closed.
	 * When waiting to connect or connecting, cancels the connection attempt. Does nothing if already disconnected.
	 * @since 0.1.4
	 * @param code The close code.
	 * @param reason The reason for closing if any.
	 * @returns A Promise that resolves when the connection is fully closed.
	 */
	public async close(code: number, reason?: string): Promise<void> {
		const state = this.sm.currentStateName;
		if (state === "disconnected") return;
		if (!this._closePromise) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this._closePromise = promise;
			this._closeResolver = resolve;
		}
		const closed = this._closePromise;
		this.sm.doTransition("user_close", code, reason);
		return closed;
	}

	/**
	 * Emit an error if anyone listens for them, otherwise degrade to a debug event.
	 * "error" with zero listeners throws by EventEmitter contract, which must never happen inside wire-handling code paths.
	 * @since 0.19.0
	 */
	private _emitError(error: Error): void {
		if (this.listenerCount("error")) this.emit("error", error);
		else this.emit("debug", `Unlistened error: ${error.message}`);
	}

	/**
	 * Method to raw write messages to the server.
	 * @since 0.4.1
	 * @param packet Buffer containing the message to send.
	 * @param opcode WebSocket spec op code.
	 */
	private _write(packet: Buffer, opcode: number): void {
		const socket = this._socket;
		if (!socket?.writable) {
			// Tried to write to a missing, closed, or not-writeable socket. Either way, this connection isn't recoverable, we need a new one.
			// Deferred to a microtask because _write can run inside a state transition callback and transitions must not nest.
			queueMicrotask(() => {
				const state = this.sm.currentStateName;
				if (state === "connected" || state === "half_close") this.sm.doTransition("disconnect");
			});
			return;
		}
		const length = packet.length;
		let frame: Buffer;
		if (length < 126) {
			frame = Buffer.allocUnsafe(6 + length);
			frame[1] = 128 + length;
		} else if (length < (1 << 16)) {
			frame = Buffer.allocUnsafe(8 + length);
			frame[1] = 254;
			frame[2] = length >> 8;
			frame[3] = length & 255;
		} else {
			frame = Buffer.allocUnsafe(14 + length);
			frame[1] = 255;
			frame.writeBigUInt64BE(BigInt(length), 2);
		}
		frame[0] = 128 + opcode;
		frame.writeUInt32BE(0, frame.length - length - 4);
		frame.set(packet, frame.length - length);
		socket.write(frame);
	}

	/**
	 * Handler for when there is data in the socket's Buffer to read.
	 * @since 0.3.1
	 */
	private _onReadable(): void {
		const socket = this._socket;
		if (!socket) return;
		while(socket.readableLength > 1) {
			let length = readRange(socket, 1, 1) & 127;
			let bytes = 0;
			if (length > 125) {
				bytes = length === 126 ? 2 : 8;
				if (socket.readableLength < 2 + bytes) return;
				length = readRange(socket, 2, bytes);
			}
			const frame = socket.read(2 + bytes + length) as Buffer;
			if (!frame) return;
			const fin = frame[0] >> 7;
			const opcode = frame[0] & 15;
			if (fin !== 1 || opcode === 0) this._emitError(new Error("discord actually does send messages with fin=0. if you see this error let me know"));
			const payload = frame.subarray(2 + bytes);
			try {
				this._processFrame(opcode, payload);
			} catch (e) {
				// Malformed wire data (bad zlib chunk, invalid JSON/ETF) would otherwise throw into the socket's readable handler and crash the process.
				// The stream can't be trusted anymore, so tear the connection down and let the connector reconnect/resume.
				return this.sm.doTransition("error", e instanceof Error ? e : new Error(String(e)));
			}
		}
	}

	/**
	 * Transforms/reads raw messages from the server and emits the appropriate event.
	 * @since 0.4.1
	 * @param opcode WebSocket spec op code.
	 * @param message Buffer of data to transform/read.
	 */
	private _processFrame(opcode: number, message: Buffer): void {
		switch (opcode) {
		case 1: {
			let packet: any;
			if (this.encoding === "json") packet = JSON.parse(message.toString());
			else packet = message;
			this.emit("ws_receive", packet);
			break;
		}
		case 2: {
			let packet;
			if (this.compress) {
				let error = null;
				let data = null;
				const z = this._zlib!;
				// @ts-ignore
				z.close = z._handle.close = z._v;
				try {
					// @ts-ignore
					data = z._processChunk(message, constants.Z_SYNC_FLUSH);
				} catch(e) {
					error = e;
				}
				const l = message.length;
				if (message[l - 4] !== 0 || message[l - 3] !== 0 || message[l - 2] !== 255 || message[l - 1] !== 255) this._emitError(new Error("discord actually does send fragmented zlib messages. If you see this error let me know"));
				// @ts-ignore
				z.close = z._c;
				// @ts-ignore
				z._handle = z._h;
				// @ts-ignore
				z._handle.close = z._hc;
				// @ts-ignore
				z._events.error = void 0;
				// @ts-ignore
				z._eventCount--;
				z.removeAllListeners("error");
				if (error) {
					this._emitError(new Error("Zlib error processing chunk"));
					this._write(Buffer.allocUnsafe(0), 8);
					return;
				}
				if (!data) {
					this._emitError(new Error("Data from zlib processing was null. If you see this error let me know")); // This should never run, but TS is lame
					return;
				}
				if (this.encoding === "json") packet = JSON.parse(String(data));
				else if (this.encoding === "etf") packet = etf.read(data, 1);
				else if (this.encoding === "other") packet = data;
			} else if (this.encoding === "json") packet = JSON.parse(inflateSync(message).toString());
			else if (this.encoding === "etf") packet = etf.read(message, 1);
			else if (this.encoding === "other") packet = message;
			this.emit("ws_receive", packet);
			break;
		}
		case 8: {
			const code = message.length > 1 ? (message[0] << 8) + message[1] : null; // an empty close frame has no code. Leave null so ws_close falls back to 1006
			this._lastCloseCode = code;
			this._lastCloseReason = message.length > 2 ? message.subarray(2).toString() : "";
			if (this.sm.currentStateName !== "half_close") this._write(code === null ? Buffer.allocUnsafe(0) : Buffer.from([code >> 8, code & 255]), 8);
			break;
		}
		case 9: {
			this._write(message, 10);
			break;
		}
		}
	}
}

function createReq(address: string, extraHeaders?: Record<string, any>): { req: http.ClientRequest, key: string } {
	const key = randomBytes(16).toString("base64");
	const url = new URL(address);
	const useHTTPS = (url.protocol === "https:" || url.protocol === "wss:") || url.port === "443";
	const port = url.port || (useHTTPS ? "443" : "80");
	const req = (useHTTPS ? https : http).request({
		hostname: url.hostname,
		path: `${url.pathname}${url.search}`,
		port: port,
		headers: {
			"Connection": "Upgrade",
			"Upgrade": "websocket",
			"User-Agent": `Discordbot (https://github.com/DasWolke/CloudStorm, ${Constants.VERSION}) Node.js/${process.version}`,
			"Sec-WebSocket-Key": key,
			"Sec-WebSocket-Version": "13",
			...extraHeaders
		}
	});
	req.end();
	return { req, key };
}

function readRange(socket: Socket, index: number, bytes: number): number {
	let cursor = 0;
	let read = 0;
	let num = 0;

	// @ts-ignore
	const readable = socket._readableState;
	let currentBufferIndex = readable.bufferIndex;
	let currentBuffer = readable.buffer.head ?? readable.buffer[currentBufferIndex];

	do {
		const data = currentBuffer.data ?? currentBuffer;
		for (const element of data) {
			if (++cursor > index) {
				num *= 256;
				num += element;
				if (++read === bytes) return num;
			}
		}
	} while((currentBuffer = (currentBuffer.next ?? readable.buffer[++currentBufferIndex])));
	throw new Error("readRange failed?");
}


export = BetterWs;
