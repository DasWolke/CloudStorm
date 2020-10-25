"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GATEWAY_VERSION = exports.GATEWAY_OP_CODES = void 0;
exports.GATEWAY_OP_CODES = {
    DISPATCH: 0,
    HEARTBEAT: 1,
    IDENTIFY: 2,
    STATUS_UPDATE: 3,
    VOICE_STATE_UPDATE: 4,
    VOICE_SERVER_PING: 5,
    RESUME: 6,
    RECONNECT: 7,
    REQUEST_GUILD_MEMBERS: 8,
    INVALID_SESSION: 9,
    HELLO: 10,
    HEARTBEAT_ACK: 11
};
exports.GATEWAY_VERSION = 8;
exports.default = { GATEWAY_OP_CODES: exports.GATEWAY_OP_CODES, GATEWAY_VERSION: exports.GATEWAY_VERSION };
