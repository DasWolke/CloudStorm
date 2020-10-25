"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const events_1 = require("events");
const zlib_sync_1 = __importDefault(require("zlib-sync"));
let Erlpack;
try {
    Erlpack = require("erlpack");
}
catch (e) { }
const Constants_1 = require("../Constants");
const ws_1 = __importDefault(require("ws"));
const RatelimitBucket_1 = __importDefault(require("./RatelimitBucket"));
class BetterWs extends events_1.EventEmitter {
    constructor(address, options = {}) {
        super();
        this.ws = new ws_1.default(address, options);
        this.bindWs(this.ws);
        this.wsBucket = new RatelimitBucket_1.default(120, 60000);
        this.statusBucket = new RatelimitBucket_1.default(5, 60000);
        this.zlibInflate = new zlib_sync_1.default.Inflate({ chunkSize: 65535 });
    }
    emit(event, ...args) {
        return super.emit(event, args);
    }
    once(event, listener) {
        return super.once(event, listener);
    }
    on(event, listener) {
        return super.on(event, listener);
    }
    get rawWs() {
        return this.ws;
    }
    bindWs(ws) {
        ws.on("message", (msg) => {
            this.onMessage(msg);
        });
        ws.on("close", (code, reason) => this.onClose(code, reason));
        ws.on("error", (err) => {
            this.emit("error", err);
        });
        ws.on("open", () => this.onOpen());
    }
    recreateWs(address, options = {}) {
        this.ws.removeAllListeners();
        this.zlibInflate = new zlib_sync_1.default.Inflate({ chunkSize: 65535 });
        this.ws = new ws_1.default(address, options);
        this.options = options;
        this.wsBucket.dropQueue();
        this.wsBucket = new RatelimitBucket_1.default(120, 60000);
        this.statusBucket = new RatelimitBucket_1.default(5, 60000);
        this.bindWs(this.ws);
    }
    onOpen() {
        this.emit("ws_open");
    }
    onMessage(message) {
        let parsed;
        try {
            const length = message.length;
            const flush = length >= 4 &&
                message[length - 4] === 0x00 &&
                message[length - 3] === 0x00 &&
                message[length - 2] === 0xFF &&
                message[length - 1] === 0xFF;
            this.zlibInflate.push(message, flush ? zlib_sync_1.default.Z_SYNC_FLUSH : false);
            if (!flush)
                return;
            if (Erlpack) {
                parsed = Erlpack.unpack(this.zlibInflate.result);
            }
            else {
                parsed = JSON.parse(String(this.zlibInflate.result));
            }
        }
        catch (e) {
            this.emit("error", `Message: ${message} was not parseable`);
            return;
        }
        this.emit("ws_message", parsed);
    }
    onClose(code, reason) {
        this.emit("ws_close", code, reason);
    }
    sendMessage(data) {
        this.emit("debug_send", data);
        return new Promise((res, rej) => {
            let status = data.op === Constants_1.GATEWAY_OP_CODES.STATUS_UPDATE;
            try {
                if (Erlpack) {
                    data = Erlpack.pack(data);
                }
                else {
                    data = JSON.stringify(data);
                }
            }
            catch (e) {
                return rej(e);
            }
            let sendMsg = () => {
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
                this.statusBucket.queue(sendMsg);
            }
            else {
                sendMsg();
            }
        });
    }
    close(code = 1000, reason = "") {
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
module.exports = BetterWs;
