import fs = require("node:fs");
import path = require("node:path");

const Constants = {
	GATEWAY_OP_CODES: {
		/** Receive. */
		DISPATCH: 0 as const,
		/** Send/Receive. */
		HEARTBEAT: 1 as const,
		/** Send. */
		IDENTIFY: 2 as const,
		/** Send. */
		PRESENCE_UPDATE: 3 as const,
		/** Send. */
		VOICE_STATE_UPDATE: 4 as const,
		/** Send. */
		RESUME: 6 as const,
		/** Receive. */
		RECONNECT: 7 as const,
		/** Send. */
		REQUEST_GUILD_MEMBERS: 8 as const,
		/** Receive. */
		INVALID_SESSION: 9 as const,
		/** Receive. */
		HELLO: 10 as const,
		/** Receive. */
		HEARTBEAT_ACK: 11 as const,
		/** Send. */
		REQUEST_SOUNDBOARD_SOUNDS: 31 as const,
		/** Send. */
		REQUEST_CHANNEL_INFO: 43 as const
	},
	GATEWAY_VERSION: 10 as const,
	/** The version string of CloudStorm as read from package.json. */
	VERSION: JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), { encoding: "utf8" })).version as string,
	/**
	 * Builds the full gateway address to connect to from a base url and the client's ws options.
	 * @param url Base gateway wss url as handed out by Discord (getGatewayBot url or a READY resume_gateway_url).
	 * @param ws The client's ws options determining encoding and compression.
	 */
	getGatewayAddress(url: string, ws?: { encoding?: "etf" | "json"; compress?: boolean }): string {
		return `${url}?v=${Constants.GATEWAY_VERSION}&encoding=${ws?.encoding === "etf" ? "etf" : "json"}${ws?.compress ? "&compress=zlib-stream" : ""}`;
	}
};

export = Constants;
