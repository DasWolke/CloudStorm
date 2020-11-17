"use strict";

/**
 * Receive.
 */
const DISPATCH = 0 as const;
/**
 * Send/Receive.
 */
const HEARTBEAT = 1 as const;
/**
 * Send.
 */
const IDENTIFY = 2 as const;
/**
 * Send.
 */
const PRESENCE_UPDATE = 3 as const;
/**
 * Send.
 */
const VOICE_STATE_UPDATE = 4 as const;
/**
 * Send.
 */
const RESUME = 6 as const;
/**
 * Receive.
 */
const RECONNECT = 7 as const;
/**
 * Send.
 */
const REQUEST_GUILD_MEMBERS = 8 as const;
/**
 * Receive.
 */
const INVALID_SESSION = 9 as const;
/**
 * Receive.
 */
const HELLO = 10 as const;
/**
 * Receive.
 */
const HEARTBEAT_ACK = 11 as const;

export const GATEWAY_OP_CODES = {
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
export const GATEWAY_VERSION = 8;
export default { GATEWAY_OP_CODES, GATEWAY_VERSION };
