/// <reference types="node" />
import { EventEmitter } from "events";
import zlib from "zlib-sync";
import WebSocket from "ws";
import RatelimitBucket from "./RatelimitBucket";
interface BWSEvents {
    error: [Error | string];
    ws_open: [];
    ws_close: [number, string];
    ws_message: [import("../Types").IGatewayMessage];
    debug_send: [import("../Types").IWSMessage];
    debug: [string];
}
declare class BetterWs extends EventEmitter {
    ws: WebSocket;
    wsBucket: RatelimitBucket;
    statusBucket: RatelimitBucket;
    zlibInflate: zlib.Inflate;
    options: WebSocket.ClientOptions;
    constructor(address: string, options?: import("ws").ClientOptions);
    emit<E extends keyof BWSEvents>(event: E, ...args: BWSEvents[E]): boolean;
    once<E extends keyof BWSEvents>(event: E, listener: (...args: BWSEvents[E]) => any): this;
    on<E extends keyof BWSEvents>(event: E, listener: (...args: BWSEvents[E]) => any): this;
    get rawWs(): WebSocket;
    private bindWs;
    recreateWs(address: string, options?: import("ws").ClientOptions): void;
    private onOpen;
    private onMessage;
    private onClose;
    sendMessage(data: any): Promise<void>;
    close(code?: number, reason?: string): Promise<void>;
}
export = BetterWs;
