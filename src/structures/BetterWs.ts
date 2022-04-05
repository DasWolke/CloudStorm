"use strict";

// This ultra light weigth WS code is a slimmed down version originally found at https://github.com/timotejroiko/tiny-discord
// Modifications and use of this code was granted for this project by the author, Timotej Roiko.
// A major thank you to Tim for better performing software.

import { EventEmitter } from "events";
import { randomBytes, createHash } from "crypto";
import { createInflate, inflateSync, constants } from "zlib";
import { request } from "https";
import util from "util";
import { GATEWAY_OP_CODES } from "../Constants";

import RatelimitBucket from "./RatelimitBucket";

interface BWSEvents {
	ws_open: [];
	ws_close: [number, string];
	ws_message: [import("../Types").IGatewayMessage];
	debug_send: [import("../Types").IWSMessage];
	debug: [string];
}

interface BetterWs {
	addListener<E extends keyof BWSEvents>(event: E, listener: (...args: BWSEvents[E]) => any): this;
	emit<E extends keyof BWSEvents>(event: E, ...args: BWSEvents[E]): boolean;
	eventNames(): Array<keyof BWSEvents>;
	listenerCount(event: keyof BWSEvents): number;
	listeners(event: keyof BWSEvents): Array<(...args: Array<any>) => any>;
	off<E extends keyof BWSEvents>(event: E, listener: (...args: BWSEvents[E]) => any): this;
	on<E extends keyof BWSEvents>(event: E, listener: (...args: BWSEvents[E]) => any): this;
	once<E extends keyof BWSEvents>(event: E, listener: (...args: BWSEvents[E]) => any): this;
	prependListener<E extends keyof BWSEvents>(event: E, listener: (...args: BWSEvents[E]) => any): this;
	prependOnceListener<E extends keyof BWSEvents>(event: E, listener: (...args: BWSEvents[E]) => any): this;
	rawListeners(event: keyof BWSEvents): Array<(...args: Array<any>) => any>;
	removeAllListeners(event?: keyof BWSEvents): this;
	removeListener<E extends keyof BWSEvents>(event: E, listener: (...args: BWSEvents[E]) => any): this;
}

/**
 * Helper Class for simplifying the websocket connection to Discord.
 */
class BetterWs extends EventEmitter {
	public encoding: "etf" | "json";
	public compress: boolean;
	public address: string;
	public options: import("../Types").IClientWSOptions;
	public wsBucket = new RatelimitBucket(120, 60000);
	public presenceBucket = new RatelimitBucket(5, 60000);

	private _socket: import("net").Socket | null;
	private _internal: { closePromise: Promise<void> | null; zlib: import("zlib").Inflate | null; };
	private _connecting = false;

	public constructor(address: string, options: import("../Types").IClientWSOptions) {
		super();

		this.encoding = options.encoding === "etf" ? "etf" : "json";
		this.compress = options.compress || false;
		this.address = address;
		this.options = options;

		this._socket = null;
		this._internal = {
			closePromise: null,
			zlib: null,
		};
	}

	public get status() {
		const internal = this._internal;
		if (this._connecting) return 2;
		if (internal.closePromise) return 3; // closing
		if (!this._socket) return 4; // closed
		return 1; // connected
	}

	public connect(): Promise<void> {
		if (this._socket) return Promise.resolve(void 0);
		const key = randomBytes(16).toString("base64");
		const url = new URL(this.address);
		const req = request({
			hostname: url.hostname,
			path: `${url.pathname}${url.search}`,
			headers: {
				"Connection": "Upgrade",
				"Upgrade": "websocket",
				"Sec-WebSocket-Key": key,
				"Sec-WebSocket-Version": "13",
			}
		});
		this._connecting = true;
		return new Promise((resolve, reject) => {
			req.on("upgrade", (res, socket) => {
				const hash = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
				const accept = res.headers["sec-websocket-accept"];
				if (hash !== accept) {
					socket.end(() => {
						this.emit("debug", "Failed websocket-key validation");
						this._connecting = false;
						reject(new Error(`Invalid Sec-Websocket-Accept | expected: ${hash} | received: ${accept}`));
					});
					return;
				}
				socket.on("error", this._onError.bind(this));
				socket.on("close", this._onClose.bind(this));
				socket.on("readable", this._onReadable.bind(this));
				this._socket = socket;
				this._connecting = false;
				if (this.compress) {
					const z = createInflate();
					// @ts-ignore
					z._c = z.close;
					// @ts-ignore
					z._h = z._handle;
					// @ts-ignore
					z._hc = z._handle.close;
					// @ts-ignore
					z._v = () => void 0;
					this._internal.zlib = z;
				}
				this.emit("ws_open");
				resolve(void 0);
			});
			req.on("error", e => {
				this._connecting = false;
				reject(e);
			});
			req.end();
		});
	}

	public async close(code: number, reason?: string): Promise<void> {
		const internal = this._internal;
		if (internal.closePromise) return internal.closePromise;
		if (!this._socket) return Promise.resolve(void 0);
		let resolver: ((value: unknown) => void) | undefined;
		const promise = new Promise(resolve => {
			resolver = resolve;
			const from = Buffer.from([code >> 8, code & 255]);
			this._write(reason ? Buffer.concat([from, Buffer.from(reason)]) : from, 8);
		}).then(() => {
			internal.closePromise = null;
		});
		// @ts-ignore
		promise.resolve = resolver;
		internal.closePromise = promise;
		return promise;
	}

	public sendMessage(data: import("../Types").IWSMessage): Promise<void> {
		if (!isValidRequest(data)) return Promise.reject(new Error("Invalid request"));

		return new Promise(res => {
			const presence = data.op === GATEWAY_OP_CODES.PRESENCE_UPDATE;
			const sendMsg = () => {
				this.wsBucket.queue(() => {
					this.emit("debug_send", data);
					if (this.encoding === "json") this._write(Buffer.from(JSON.stringify(data)), 1);
					else {
						const etf = writeETF(data);
						this._write(etf, 2);
					}
					res(void 0);
				});
			};
			if (presence) this.presenceBucket.queue(sendMsg);
			else sendMsg();
		});
	}

	private _write(packet: Buffer, opcode: number) {
		const socket = this._socket;
		if (!socket || !socket.writable) return;
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

	private _onError(error: Error) {
		if (!this._socket) return;
		this.emit("debug", util.inspect(error, true, 1, false));
		this._write(Buffer.allocUnsafe(0), 8);
	}

	private _onClose() {
		console.log("socket closed");
		const socket = this._socket;
		const internal = this._internal;
		if (!socket) return;
		this.emit("debug", "Connection closed");
		socket.removeListener("data", this._onReadable);
		socket.removeListener("error", this._onError);
		socket.removeListener("close", this._onClose);
		this.wsBucket.dropQueue();
		this.presenceBucket.dropQueue();
		this._socket = null;
		if (internal.zlib) {
			internal.zlib.close();
			internal.zlib = null;
		}
		// @ts-ignore
		if (internal.closePromise) internal.closePromise.resolve(void 0);
	}

	private _onReadable() {
		const socket = this._socket;
		while(socket!.readableLength > 1) {
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
			if (fin !== 1 || opcode === 0) this.emit("debug", "discord actually does send messages with fin=0. if you see this error let me know");
			const payload = frame.slice(2 + bytes);
			this._processFrame(opcode, payload);
		}
	}

	private _processFrame(opcode: number, message: Buffer) {
		const internal = this._internal;
		switch (opcode) {
		case 1: {
			const packet = JSON.parse(message.toString());
			this.emit("ws_message", packet);
			break;
		}
		case 2: {
			let packet;
			if (this.compress) {
				const z = internal.zlib;
				let error = null;
				let data = null;
				// @ts-ignore
				z.close = z._handle.close = z._v;
				try {
					// @ts-ignore
					data = z._processChunk(message, constants.Z_SYNC_FLUSH);
				} catch(e) {
					error = e;
				}
				const l = message.length;
				if (message[l - 4] !== 0 || message[l - 3] !== 0 || message[l - 2] !== 255 || message[l - 1] !== 255) this.emit("debug", "discord actually does send fragmented zlib messages. If you see this error let me know");
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
				z!.removeAllListeners("error");
				if (error) {
					this.emit("debug", "Zlib error");
					this._write(Buffer.allocUnsafe(0), 8);
					return;
				}
				if (!data) {
					this.emit("debug", "Data from zlib processing was null. If you see this error let me know"); // This should never run, but TS is lame
					return;
				}
				packet = this.encoding === "json" ? JSON.parse(String(data)) : readETF(data, 1);
			} else if (this.encoding === "json") {
				const data = inflateSync(message);
				packet = JSON.parse(data.toString());
			} else packet = readETF(message, 1);
			this.emit("ws_message", packet);
			break;
		}
		case 8: {
			const code = message.length > 1 ? (message[0] << 8) + message[1] : 0;
			const reason = message.length > 2 ? message.slice(2).toString() : "";
			this.emit("ws_close", code, reason);
			this._write(Buffer.from([code >> 8, code & 255]), 8);
			break;
		}
		case 9: {
			this._write(message, 10);
			break;
		}
		}
	}
}

function isValidRequest(value: import("../Types").IWSMessage) {
	return value && typeof value === "object" && Number.isInteger(value.op) && typeof value.d !== "undefined";
}

function readRange(socket: import("net").Socket, index: number, bytes: number) {
	// @ts-ignore
	let head = socket._readableState.buffer.head;
	let cursor = 0;
	let read = 0;
	let num = 0;
	do {
		for (let i = 0; i < head.data.length; i++) {
			if (++cursor > index) {
				num *= 256;
				num += head.data[i];
				if (++read === bytes) return num;
			}
		}
	} while((head = head.next));
	throw new Error("readRange failed?");
}

function readETF(data: Buffer, start: number) {
	let view: DataView | undefined;
	let x = start;
	const loop = () => {
		const type = data[x++];
		switch(type) {
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
			if (!view) view = new DataView(data.buffer, data.offset, data.byteLength);
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

function writeETF(data: any) {
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
	return Buffer.from(b.slice(0, i));
}


export = BetterWs;
