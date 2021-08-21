"use strict";

import { EventEmitter } from "events";
import zlib from "zlib";

let Erlpack: typeof import("erlpack") | null;
try {
	Erlpack = require("erlpack");
} catch {
	Erlpack = null;
}
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
	public ws: WebSocket;
	public wsBucket: RatelimitBucket;
	public presenceBucket: RatelimitBucket;
	public options: WebSocket.ClientOptions;

	/**
	 * Create a new BetterWs instance.
	 */
	public constructor(address: string, options: import("ws").ClientOptions = {}) {
		super();
		this.ws = new WebSocket(address, options);
		this.bindWs(this.ws);
		this.wsBucket = new RatelimitBucket(120, 60000);
		this.presenceBucket = new RatelimitBucket(5, 20000);
	}

	/**
	 * Get the raw websocket connection currently used.
	 */
	public get rawWs(): WebSocket {
		return this.ws;
	}

	/**
	 * Add eventlisteners to a passed websocket connection.
	 * @param ws Websocket.
	 */
	private bindWs(ws: import("ws")): void {
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
	 * Create a new websocket connection if the old one was closed/destroyed.
	 * @param address Address to connect to.
	 * @param options Options used by the websocket connection.
	 */
	public recreateWs(address: string, options: import("ws").ClientOptions = {}): void {
		this.ws.removeAllListeners();
		this.ws = new WebSocket(address, options);
		this.options = options;
		this.wsBucket.dropQueue();
		this.wsBucket = new RatelimitBucket(120, 60000);
		this.presenceBucket = new RatelimitBucket(5, 60000);
		this.bindWs(this.ws);
	}

	/**
	 * Called upon opening of the websocket connection.
	 */
	private onOpen(): void {
		this.emit("ws_open");
	}

	/**
	 * Called once a websocket message is received,
	 * uncompresses the message using zlib and parses it via Erlpack or JSON.parse.
	 * @param message Message received by websocket.
	 */
	private onMessage(message: Buffer): void {
		let parsed: IGatewayMessage;
		try {
			const length = message.length;
			const flush = length >= 4 &&
				message[length - 4] === 0x00 &&
				message[length - 3] === 0x00 &&
				message[length - 2] === 0xFF &&
				message[length - 1] === 0xFF;
			const inflated = zlib.inflateSync(message, { flush: flush ? zlib.constants.Z_SYNC_FLUSH : undefined, chunkSize: 65535 });
			if (!flush) return;
			if (Erlpack) {
				parsed = Erlpack.unpack(inflated);
			} else {
				parsed = JSON.parse(String(inflated));
			}
		} catch (e) {
			this.emit("error", `Message: ${message} was not parseable`);
			return;
		}
		this.emit("ws_message", parsed);
	}

	/**
	 * Called when the websocket connection closes for some reason.
	 * @param code Websocket close code.
	 * @param reason Reason of the close if any.
	 */
	private onClose(code: number, reason: string): void {
		this.emit("ws_close", code, reason);
	}

	/**
	 * Send a message to the Discord gateway.
	 * @param data Data to send.
	 */
	public sendMessage(data: any): Promise<void> {
		if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("WS is not open"));
		this.emit("debug_send", data);
		return new Promise((res, rej) => {
			const presence = data.op === GATEWAY_OP_CODES.PRESENCE_UPDATE;
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
			if (presence) {
				// same here
				this.presenceBucket.queue(sendMsg);
			} else {
				sendMsg();
			}
		});
	}

	/**
	 * Close the current websocket connection.
	 * @param code Websocket close code to use.
	 * @param reason Reason of the disconnect.
	 */
	public close(code = 1000, reason = "Unknown"): Promise<void> {
		if (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED) return Promise.reject(new Error("WS is already closing or is closed"));
		return new Promise((res, rej) => {
			const timeout = setTimeout(() => {
				return rej("Websocket not closed within 5 seconds");
			}, 5 * 1000);
			this.ws.once("close", () => {
				clearTimeout(timeout);
				return res();
			});
			this.ws.close(code, reason);
		});
	}
}

export = BetterWs;
