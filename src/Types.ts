import type {
	GatewayReceivePayload,
	GatewayDispatchPayload,
	GatewayPresenceUpdateData,
	GatewaySendPayload
} from "discord-api-types/v10";

import type http = require("node:http");

import type { SnowTransfer } from "snowtransfer";

import type { IntentResolvable } from "./Intents";

export type IGatewayMessage = GatewayReceivePayload & { shard_id: number; };

export type IGatewayDispatch = GatewayDispatchPayload & { shard_id: number; };

export type IClientOptions = {
	largeGuildThreshold?: number;
	/**
	 * A note on "auto" sharding:
	 * "auto" will always start at 0 as there is no way to know the next available shard id.
	 * If you have more than one "cluster", you must specify an Array of shard ids. along with totalShards
	 */
	shards?: "auto" | Array<number>;
	/**
	 * Ignored and overwrote if using "auto" sharding.
	 * The total number of shards expected across all clusters.
	 */
	totalShards?: number;
	initialPresence?: GatewayPresenceUpdateData;
	intents?: IntentResolvable;
	snowtransferInstance?: SnowTransfer;
	/**
	 * Resume data as exported by Client.getResumeData() from a previous process, keyed by shard id.
	 * Seeded shards resume their sessions instead of identifying, which doesn't count against the identify limit.
	 * Shards whose sessions Discord no longer accepts (too old, shard config changed) fall back to identifying automatically.
	 */
	resumeData?: Record<number, IShardResumeData>;
	ws?: IClientWSOptions;
}

/**
 * Everything needed to resume one shard's gateway session, e.g. in another process after a restart.
 * JSON-serializable, so it can be written to a file or any other store as-is.
 */
export type IShardResumeData = {
	/** The id of the session that can be resumed. */
	sessionId: string;
	/** The last sequence number processed in the session. Discord replays everything after it on resume. */
	seq: number;
	/**
	 * The gateway address the session must be resumed at, as assigned by Discord in READY.
	 * The token gets sent there, so a seeded address is only used if it is on the gateway endpoint's host or a sibling under the same domain.
	 * Anything else is ignored and the resume is attempted at the endpoint instead.
	 */
	resumeAddress: string | null;
}

export type IClientWSOptions = {
	compress?: boolean;
	/** "etf" requires the optional peer dependency wetf to be installed */
	encoding?: "etf" | "json";
	headers?: Record<string, any>;
	bypassBuckets?: boolean;
	connectThrottle?: number;
	/** The most bytes a frame, a reassembled message or an inflated message may be before the connection is dropped. Defaults to 100MiB */
	maxPayload?: number;
}

export type BWSEvents = {
	ws_open: [];
	ws_close: [number, string];
	ws_receive: [any];
	ws_send: [any];
	debug: [string];
	error: [Error];
	upgrade: [http.IncomingHttpHeaders];
}

export type ClientEvents = {
	debug: [string];
	/** What was sent to Discord. The token in identify and resume payloads is replaced with "[redacted]" */
	rawSend: [GatewaySendPayload];
	rawReceive: [GatewayReceivePayload];
	error: [Error]; // no processing messages

	event: [IGatewayMessage];
	dispatch: [IGatewayDispatch];
	shardReady: [{ id: number; ready: boolean; }];
	/** All shards are ready. Emits again every time a shard comes back from a reconnect, so use once() for one time setup */
	ready: [];
	disconnected: [];
}

export type ConnectorEvents = {
	queueIdentify: [number];
	ready: [boolean];
	/** close code, close reason, gracefulClose (the close was deliberate, including internal reconnects), manual (the user requested this disconnect) */
	disconnect: [number, string, boolean, boolean];
}

export type ShardEvents = {
	/** close code, close reason, gracefulClose (the close was deliberate, including internal reconnects), manual (the user requested this disconnect) */
	disconnect: [number, string, boolean, boolean];
	ready: [boolean];
	queueIdentify: [number];
}
