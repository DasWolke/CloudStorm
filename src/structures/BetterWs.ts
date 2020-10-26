"use strict";

import { EventEmitter } from "events";
import zlib from "zlib-sync";
let Erlpack: typeof import("erlpack");
try {
	Erlpack = require("erlpack");
	// eslint-disable-next-line no-empty
} catch (e) {}
import { GATEWAY_OP_CODES } from "../Constants";
import WebSocket from "ws";

import RatelimitBucket from "./RatelimitBucket";
import { IGatewayMessage } from "../Types";

interface BWSEvents {
	error: [Error | string];
	ws_open: [];
	ws_close: [number, string];
	ws_message: [import("../Types").IGatewayMessage];
	debug_send: [import("../Types").IWSMessage];
	debug: [string];
}

/**
 * Helper Class for simplifying the websocket connection to discord
 */
class BetterWs extends EventEmitter {
	public ws: WebSocket;
	public wsBucket: RatelimitBucket;
	public statusBucket: RatelimitBucket;
	public zlibInflate: zlib.Inflate;
	public options: WebSocket.ClientOptions;

	/**
	 * Create a new BetterWs instance
	 */
	public constructor(address: string, options: import("ws").ClientOptions = {}) {
		super();
		this.ws = new WebSocket(address, options);
		this.bindWs(this.ws);
		this.wsBucket = new RatelimitBucket(120, 60000);
		this.statusBucket = new RatelimitBucket(5, 60000);
		this.zlibInflate = new zlib.Inflate({ chunkSize: 65535 });
	}

	public emit<E extends keyof BWSEvents>(event: E, ...args: BWSEvents[E]) {
		return super.emit(event, args);
	}
	public once<E extends keyof BWSEvents>(event: E, listener: (...args: BWSEvents[E]) => any) {
		// @ts-ignore SHUT UP!!!
		return super.once(event, listener);
	}
	public on<E extends keyof BWSEvents>(event: E, listener: (...args: BWSEvents[E]) => any) {
		// @ts-ignore
		return super.on(event, listener);
	}

	/**
	 * Get the raw websocket connection currently used
	 */
	public get rawWs() {
		return this.ws;
	}

	/**
	 * Add eventlisteners to a passed websocket connection
	 * @param ws websocket
	 */
	private bindWs(ws: import("ws")) {
		ws.on("message", (msg) => {
			this.onMessage(msg as Buffer);
		});
		ws.on("close", (code, reason) => this.onClose(code, reason));
		ws.on("error", (err) => {
			this.emit("error", err);
		});
		ws.on("open", () => this.onOpen());
	}

	/**
	 * Create a new Websocket Connection if the old one was closed/destroyed
	 * @param address address to connect to
	 * @param options options used by the websocket connection
	 */
	public recreateWs(address: string, options: import("ws").ClientOptions = {}) {
		this.ws.removeAllListeners();
		this.zlibInflate = new zlib.Inflate({ chunkSize: 65535 });
		this.ws = new WebSocket(address, options);
		this.options = options;
		this.wsBucket.dropQueue();
		this.wsBucket = new RatelimitBucket(120, 60000);
		this.statusBucket = new RatelimitBucket(5, 60000);
		this.bindWs(this.ws);
	}

	/**
	 * Called upon opening of the websocket connection
	 */
	private onOpen() {
		this.emit("ws_open");
	}

	/**
	 * Called once a websocket message is received,
	 * uncompresses the message using zlib and parses it via Erlpack or JSON.parse
	 * @param message message received by websocket
	 */
	private onMessage(message: Buffer) {
		let parsed: IGatewayMessage;
		try {
			const length = message.length;
			const flush = length >= 4 &&
				message[length - 4] === 0x00 &&
				message[length - 3] === 0x00 &&
				message[length - 2] === 0xFF &&
				message[length - 1] === 0xFF;
			this.zlibInflate.push(message, flush ? zlib.Z_SYNC_FLUSH : false);
			if (!flush) return;
			if (Erlpack) {
				parsed = Erlpack.unpack(this.zlibInflate.result as Buffer);
			} else {
				parsed = JSON.parse(String(this.zlibInflate.result));
			}
		} catch (e) {
			this.emit("error", `Message: ${message} was not parseable`);
			return;
		}
		this.emit("ws_message", parsed);
	}

	/**
	 * Called when the websocket connection closes for some reason
	 * @param code websocket close code
	 * @param reason reason of the close if any
	 */
	private onClose(code: number, reason: string) {
		this.emit("ws_close", code, reason);
	}

	/**
	 * Send a message to the discord gateway
	 * @param data data to send
	 */
	public sendMessage(data: any): Promise<void> {
		this.emit("debug_send", data);
		return new Promise((res, rej) => {
			const status = data.op === GATEWAY_OP_CODES.STATUS_UPDATE;
			try {
				if (Erlpack) {
					data = Erlpack.pack(data);
				} else {
					data = JSON.stringify(data);
				}
			} catch (e) {
				return rej(e);
			}
			const sendMsg = () => {
				// The promise from wsBucket is ignored, since the method passed to it does not return a promise
				this.wsBucket.queue(() => {
					this.ws.send(data, {}, (e) => {
						if (e) {
							return rej(e);
						}
						res();
					});
				});
			};
			if (status) {
				// same here
				this.statusBucket.queue(sendMsg);
			} else {
				sendMsg();
			}
		});
	}

	/**
	 * Close the current connection
	 * @param code websocket close code to use
	 * @param reason reason of the disconnect
	 */
	public close(code = 1000, reason = ""): Promise<void> {
		return new Promise((res, rej) => {
			this.ws.close(code, reason);
			this.ws.once("close", () => {
				return res();
			});
			setTimeout(() => {
				return rej("Websocket not closed within 5 seconds");
			}, 5 * 1000);
		});
	}
}

export = BetterWs;
