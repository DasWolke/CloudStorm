"use strict";

const Constants = {
	GATEWAY_OP_CODES: {
		/**
		 * Receive.
		 */
		DISPATCH: 0 as const,
		/**
		 * Send/Receive.
		 */
		HEARTBEAT: 1 as const,
		/**
		 * Send.
		 */
		IDENTIFY: 2 as const,
		/**
		 * Send.
		 */
		PRESENCE_UPDATE: 3 as const,
		/**
		 * Send.
		 */
		VOICE_STATE_UPDATE: 4 as const,
		/**
		 * Send.
		 */
		RESUME: 6 as const,
		/**
		 * Receive.
		 */
		RECONNECT: 7 as const,
		/**
		 * Send.
		 */
		REQUEST_GUILD_MEMBERS: 8 as const,
		/**
		 * Receive.
		 */
		INVALID_SESSION: 9 as const,
		/**
		 * Receive.
		 */
		HELLO: 10 as const,
		/**
		 * Receive.
		 */
		HEARTBEAT_ACK: 11 as const
	},
	GATEWAY_VERSION: 10 as const
};

export = Constants;
