"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GATEWAY_VERSION = exports.GATEWAY_OP_CODES = void 0;
const DISPATCH = 0;
const HEARTBEAT = 1;
const IDENTIFY = 2;
const PRESENCE_UPDATE = 3;
const VOICE_STATE_UPDATE = 4;
const RESUME = 6;
const RECONNECT = 7;
const REQUEST_GUILD_MEMBERS = 8;
const INVALID_SESSION = 9;
const HELLO = 10;
const HEARTBEAT_ACK = 11;
exports.GATEWAY_OP_CODES = {
    DISPATCH,
    HEARTBEAT,
    IDENTIFY,
    PRESENCE_UPDATE,
    VOICE_STATE_UPDATE,
    RESUME,
    RECONNECT,
    REQUEST_GUILD_MEMBERS,
    INVALID_SESSION,
    HELLO,
    HEARTBEAT_ACK
};
exports.GATEWAY_VERSION = 8;
exports.default = { GATEWAY_OP_CODES: exports.GATEWAY_OP_CODES, GATEWAY_VERSION: exports.GATEWAY_VERSION };
