"use strict";

// This ultra light weight WS code is a slimmed down version originally found at https://github.com/timotejroiko/tiny-discord
// Modifications and use of this code was granted for this project by the author, Timotej Roiko.
// A major thank you to Tim for better performing software.

import { EventEmitter } from "events";
import { randomBytes, createHash } from "crypto";
import { createInflate, inflateSync, constants, type Inflate } from "zlib";
import https = require("https");
import http = require("http");
import util = require("util");

import type { Socket } from "net";

import type {
	BWSEvents,
	IClientWSOptions
} from "./Types";

import StateMachine = require("./StateMachine");
import stateMachineGraph = require("./StateMachineGraph");

/**
 * Call with an emitter and an object of callbacks, and the first event to be emitted will call the callback.
 * If the callback returns a promise, waits for the promise to resolve or reject. eventSwitch will resolve or reject with the same value.
 * All added listeners are removed before eventSwitch returns.
 */
function eventSwitch(emitter: EventEmitter, cbs: { [eventName: string]: (...args: any[]) => any }): Promise<void> {
	const realListeners = new Map<string, (...args: Array<any>) => void>();
	return Promise.race(Object.entries(cbs).map(([event, cb]) => {
		return new Promise<void>((resolve, reject) => {
			const l = (...args: Array<any>) => (async () => cb(...args))().then(resolve, reject);
			realListeners.set(event, l);
			emitter.once(event, l);
		});
	})).finally(() => {
		for (const [event, l] of realListeners.entries()) {
			emitter.removeListener(event, l);
		}
	});
}

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

	/** The raw net.Socket retreived from upgrading the connection or null if not upgraded/closed. */
	private _socket: Socket | null = null;
	/** If a request is going through to initiate a WebSocket connection and hasn't been upgraded by the server yet. */
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


	/**
	 * Creates a new lightweight WebSocket.
	 * @param address The http(s):// or ws(s):// URL cooresponding to the server to connect to.
	 * @param options Options specific to this WebSocket.
	 */
	public constructor(public address: string, public options: Omit<IClientWSOptions, "encoding"> & { encoding?: IClientWSOptions["encoding"] | "other" }) {
		super();

		this.encoding = options.encoding ?? "other";
		this.compress = options.compress ?? false;
		this.connectThrottle = options.connectThrottle ?? 10e3;

		this.sm.defineState("connect_wait", {
			onEnter: [
				() => {
					this.sm.doTransitionLater("connect_allowed", this.lastConnectAttempt - Date.now() + this.connectThrottle)
				}
			],
			onLeave: [
				() => {
					this.lastConnectAttempt = Date.now()
				}
			],
			transitions: new Map([
				["connect_allowed", {
					destination: "connecting"
				}]
			])
		})

		this.sm.defineState("connecting", {
			onEnter: [
				() => {
					const { req, key } = createReq(this.address, this.options);
					this.emit("debug", "Socket sending request to upgrade");
					return eventSwitch(req, {
						upgrade: (res: http.IncomingMessage, socket: Socket) => {
							try {
								this.sm.doTransition("upgrade", key, res, socket);
							} catch (e) {
								req.destroy();
								throw e;
							}
						},
						error: e => {
							throw e;
						},
						response: (res: http.ServerResponse) => {
							req.destroy();
							throw new Error(`Expected HTTP 101 Upgrade, but got ${res.statusCode} ${res.statusMessage}`);
						}
					}).catch(error => {
						this.sm.doTransition("error", error);
					});
				}
			],
			onLeave: [],
			transitions: new Map([
				["upgrade", {
					destination: "upgrading",
					onTransition: [
						/**
						 * Handler for when requests from connect are upgraded to WebSockets.
						 * @param key The sec key from connect.
						 * @param req The HTTP request from connect.
						 * @param resolve Promise resolver from connect.
						 * @param reject Promise rejector from connect.
						 * @param res The HTTP response from the server from connect.
						 * @param socket The raw socket from upgrading the request from connect.
						 */
						(key: string, res: http.IncomingMessage, socket: Socket) => {
							const hash = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
							const accept = res.headers["sec-websocket-accept"];
							if (hash !== accept) {
								socket.end(() => {
									this.emit("error", `Failed websocket-key validation: expected: ${hash} | received: ${accept}`);
								});
								return this.sm.doTransition("error");
							}
							socket.on("error", e => this.sm.doTransition("error", e));
							socket.on("close", () => this.sm.doTransition("disconnect"));
							socket.on("readable", this._onReadable.bind(this));
							this._socket = socket;
							if (this.compress) {
								const z = createInflate();
								// @ts-ignore
								z._c = z.close; z._h = z._handle; z._hc = z._handle.close; z._v = () => void 0;
								this._zlib = z;
							}
							this.emit("ws_open");
							this.sm.doTransition("ws_open");
						}
					]
				}]
			])
		});

		this.sm.defineState("upgrading", {
			onEnter: [],
			onLeave: [],
			transitions: new Map([
				["ws_open", { destination: "connected" }]
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
							this.emit("debug", `User requested socket close`);

							// Ask Discord to disconnect us
							const from = Buffer.from([code >> 8, code & 255]);
							this._write(reason ? Buffer.concat([from, Buffer.from(reason)]) : from, 8);
						}
					]
				}],
				["error", {
					destination: "half_close",
					onTransition: [
						(error) => {
							this.emit("error", util.inspect(error, true, 1, false));

							// Ask Discord to disconnect us
							this._write(Buffer.allocUnsafe(0), 8);
						}
					]
				}]
			])
		});

		this.sm.defineState("half_close", {
			onEnter: [
				() => {
					this.sm.doTransitionLater("close_no_response", 5000);
					const { promise, resolve } = Promise.withResolvers<void>();
					this._closePromise = promise;
					this._closeResolver = resolve;
					return this._closePromise;
				}
			],
			onLeave: [],
			transitions: new Map([
				["user_close", {
					destination: "half_close",
					onTransition: [
						() => {
							return this._closePromise; // this will exist because it was assigned in half-close, the state we are already in
						}
					]
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
		})

		this.sm.defineState("disconnected", {
			onEnter: [
				() => {
					if (this._closeResolver) this._closeResolver();
					if (this._zlib) {
						this._zlib.close();
						this._zlib = null;
					}
					this.emit("ws_close", this._lastCloseCode ?? 1006, this._lastCloseReason ?? "Abnormal Closure");
					this._lastCloseCode = null;
					this._lastCloseReason = null;
					this._socket?.removeAllListeners()
				}
			],
			onLeave: [],
			transitions: new Map([
				["user_connect", { destination: "connect_wait" }]
			])
		})

		this.sm.defineUniversalTransition("error", "disconnected");

		this.sm.freeze();

		if (process.argv.includes(`--state-machine-graph-betterws`)) {
			console.log(stateMachineGraph.graph(this.sm));
		}
	}

	/**
	 * Connects to the server.
	 * @since 0.5.0
	 */
	public connect(): void {
		this.sm.doTransition("user_connect");
	}

	/**
	 * Sends a message to the server.
	 * @since 0.1.4
	 * @param data What to send to the server.
	 * @returns A Promise that resolves when the message passes the bucket queue(s) and is written to the socket's Buffer to send.
	 */
	public sendMessage(data: any): void {
		if (this.encoding === "json") this._write(Buffer.from(JSON.stringify(data)), 1);
		else if (this.encoding === "etf") this._write(writeETF(data), 2);
		else if (this.encoding === "other") this._write(Buffer.from(data), 2);
		this.emit("ws_send", data);
	}

	/**
	 * Disconnects from the server.
	 * This can only be called when connected (returns a promise) or half-close (returns the same promise)
	 * @since 0.1.4
	 * @param code The close code.
	 * @param reason The reason for closing if any.
	 * @returns A Promise that resolves when the connection is fully closed.
	 */
	public async close(code: number, reason?: string): Promise<void> {
		this.sm.doTransition("user_close", code, reason);
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
			return this.sm.doTransition("disconnect");
		}
		const length = packet.length;
		let frame: Buffer | undefined;
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
		while((socket?.readableLength ?? 0) > 1) {
			let length = readRange(socket!, 1, 1) & 127;
			let bytes = 0;
			if (length > 125) {
				bytes = length === 126 ? 2 : 8;
				if (socket!.readableLength < 2 + bytes) return;
				length = readRange(socket!, 2, bytes);
			}
			const frame = socket!.read(2 + bytes + length) as Buffer;
			if (!frame) return;
			const fin = frame[0] >> 7;
			const opcode = frame[0] & 15;
			if (fin !== 1 || opcode === 0) this.emit("error", "discord actually does send messages with fin=0. if you see this error let me know");
			const payload = frame.subarray(2 + bytes);
			this._processFrame(opcode, payload);
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
			else if (this.encoding === "other") packet = message;
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
				if (message[l - 4] !== 0 || message[l - 3] !== 0 || message[l - 2] !== 255 || message[l - 1] !== 255) this.emit("error", "discord actually does send fragmented zlib messages. If you see this error let me know");
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
					this.emit("error", "Zlib error processing chunk");
					this._write(Buffer.allocUnsafe(0), 8);
					return;
				}
				if (!data) {
					this.emit("error", "Data from zlib processing was null. If you see this error let me know"); // This should never run, but TS is lame
					return;
				}
				if (this.encoding === "json") packet = JSON.parse(String(data));
				else if (this.encoding === "etf") packet = readETF(data, 1);
				else if (this.encoding === "other") packet = data;
			} else if (this.encoding === "json") packet = JSON.parse(inflateSync(message).toString());
			else if (this.encoding === "etf") packet = readETF(message, 1);
			else if (this.encoding === "other") packet = message;
			this.emit("ws_receive", packet);
			break;
		}
		case 8: {
			this._lastCloseCode = message.length > 1 ? (message[0] << 8) + message[1] : 0;
			this._lastCloseReason = message.length > 2 ? message.subarray(2).toString() : "";
			this._write(Buffer.from([this._lastCloseCode >> 8, this._lastCloseCode & 255]), 8);
			break;
		}
		case 9: {
			this._write(message, 10);
			break;
		}
		}
	}
}

function createReq(address: string, options: BetterWs["options"]): { req: http.ClientRequest, key: string } {
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
			"Sec-WebSocket-Key": key,
			"Sec-WebSocket-Version": "13",
			...options.headers
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

function readETF(data: Buffer, start: number): Record<any, any> | null | undefined {
	let view: DataView | undefined;
	let x = start;
	const loop = () => {
		const type = data[x++];
		switch(type) {
		case 70: {
			const float = data.readDoubleBE(x);
			x += 8;
			return float;
		}
		case 97: {
			return data[x++];
		}
		case 98: {
			const int = data.readInt32BE(x);
			x += 4;
			return int;
		}
		case 100: {
			const length = data.readUInt16BE(x);
			let atom = "";
			if (length > 30) {
				// @ts-ignore
				atom = data.latin1Slice(x += 2, x + length);
			} else {
				for (let i = x += 2; i < x + length; i++) {
					atom += String.fromCharCode(data[i]);
				}
			}
			x += length;
			if (!atom) return undefined;
			if (atom === "nil" || atom === "null") return null;
			if (atom === "true") return true;
			if (atom === "false") return false;
			return atom;
		}
		case 108: case 106: {
			const array = [] as Array<any>;
			if (type === 108) {
				const length = data.readUInt32BE(x);
				x += 4;
				for (let i = 0; i < length; i++) {
					array.push(loop());
				}
				x++;
			}
			return array;
		}
		case 107: {
			const array = [] as Array<number>;
			const length = data.readUInt16BE(x);
			x += 2;
			for (let i = 0; i < length; i++) {
				array.push(data[x++]);
			}
			return array;
		}
		case 109: {
			const length = data.readUInt32BE(x);
			let str = "";
			if (length > 30) {
				// @ts-ignore
				str = data.utf8Slice(x += 4, x + length);
			} else {
				let i = x += 4;
				const l = x + length;
				while(i < l) {
					const byte = data[i++];
					if (byte < 128) str += String.fromCharCode(byte);
					else if (byte < 224) str += String.fromCharCode(((byte & 31) << 6) + (data[i++] & 63));
					else if (byte < 240) str += String.fromCharCode(((byte & 15) << 12) + ((data[i++] & 63) << 6) + (data[i++] & 63));
					else str += String.fromCodePoint(((byte & 7) << 18) + ((data[i++] & 63) << 12) + ((data[i++] & 63) << 6) + (data[i++] & 63));
				}
			}
			x += length;
			return str;
		}
		case 110: {
			// @ts-ignore
			view ??= new DataView(data.buffer, data.offset, data.byteLength);
			const length = data[x++];
			const sign = data[x++];
			let left = length;
			let num = BigInt(0);
			while(left > 0) {
				if (left >= 8) {
					num <<= BigInt(64);
					num += view.getBigUint64(x + (left -= 8), true);
				} else if (left >= 4) {
					num <<= BigInt(32);
					// @ts-ignore
					num += BigInt(view.getUint32(x + (left -= 4)), true);
				} else if (left >= 2) {
					num <<= BigInt(16);
					// @ts-ignore
					num += BigInt(view.getUint16(x + (left -= 2)), true);
				} else {
					num <<= BigInt(8);
					num += BigInt(data[x]);
					left--;
				}
			}
			x += length;
			return (sign ? -num : num).toString();
		}
		case 116: {
			const obj = {};
			const length = data.readUInt32BE(x);
			x += 4;
			for(let i = 0; i < length; i++) {
				const key = loop();
				// @ts-ignore
				obj[key] = loop();
			}
			return obj;
		}
		}
		throw new Error(`Missing etf type: ${type}`);
	};
	return loop();
}

function writeETF(data: any): Buffer {
	const b = Buffer.allocUnsafe(1 << 12);
	b[0] = 131;
	let i = 1;
	const loop = (obj: any) => {
		const type = typeof obj;
		switch(type) {
		case "boolean": {
			b[i++] = 100;
			if (obj) {
				b.writeUInt16BE(4, i);
				// @ts-ignore
				b.latin1Write("true", i += 2);
				i += 4;
			} else {
				b.writeUInt16BE(5, i);
				// @ts-ignore
				b.latin1Write("false", i += 2);
				i += 5;
			}
			break;
		}
		case "string": {
			const length = Buffer.byteLength(obj);
			b[i++] = 109;
			b.writeUInt32BE(length, i);
			// @ts-ignore
			b.utf8Write(obj, i += 4);
			i += length;
			break;
		}
		case "number": {
			if (Number.isInteger(obj)) {
				const abs = Math.abs(obj);
				if (abs < 2147483648) {
					b[i++] = 98;
					b.writeInt32BE(obj, i);
					i += 4;
				} else if (abs < Number.MAX_SAFE_INTEGER) {
					b[i++] = 110;
					b[i++] = 8;
					b[i++] = Number(obj < 0);
					b.writeBigUInt64LE(BigInt(abs), i);
					i += 8;
					break;
				} else {
					b[i++] = 70;
					b.writeDoubleBE(obj, i);
					i += 8;
				}
			} else {
				b[i++] = 70;
				b.writeDoubleBE(obj, i);
				i += 8;
			}
			break;
		}
		case "bigint": {
			b[i++] = 110;
			b[i++] = 8;
			b[i++] = Number(obj < 0);
			b.writeBigUInt64LE(obj, i);
			i += 8;
			break;
		}
		case "object": {
			if (obj === null) {
				b[i++] = 100;
				b.writeUInt16BE(3, i);
				// @ts-ignore
				b.latin1Write("nil", i += 2);
				i += 3;
			} else if (Array.isArray(obj)) {
				if (obj.length) {
					b[i++] = 108;
					b.writeUInt32BE(obj.length, i);
					i += 4;
					for (const item of obj) {
						loop(item);
					}
				}
				b[i++] = 106;
			} else {
				const entries = Object.entries(obj).filter(x => typeof x[1] !== "undefined");
				b[i++] = 116;
				b.writeUInt32BE(entries.length, i);
				i += 4;
				for(const [key, value] of entries) {
					loop(key);
					loop(value);
				}
			}
			break;
		}
		}
	};
	loop(data);
	return Buffer.from(b.subarray(0, i));
}


export = BetterWs;
