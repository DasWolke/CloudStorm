import type {
	GatewayReceivePayload,
	GatewayDispatchPayload,
	GatewayPresenceUpdateData,
	GatewaySendPayload
} from "discord-api-types/v10";

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
	ws?: IClientWSOptions;
}

export type IClientWSOptions = {
	compress?: boolean;
	encoding?: "etf" | "json";
	headers?: Record<string, any>;
	bypassBuckets?: boolean;
	connectThrottle?: number;
}

export type BWSEvents = {
	ws_open: [];
	ws_close: [number, string];
	ws_receive: [any];
	ws_send: [any];
	debug: [string];
	error: [string];
}

export type ClientEvents = {
	debug: [string];
	rawSend: [GatewaySendPayload];
	rawReceive: [GatewayReceivePayload];
	error: [string]; // no processing messages

	event: [IGatewayMessage];
	dispatch: [IGatewayDispatch];
	shardReady: [{ id: number; ready: boolean; }];
	ready: [];
	disconnected: [];
}

export type ConnectorEvents = {
	queueIdentify: [number];
	ready: [boolean];
	disconnect: [number, string, boolean];
	stateChange: ["connecting" | "identifying" | "resuming" | "ready" | "disconnected"]
}

export type ShardEvents = {
	disconnect: [number, string, boolean];
	ready: [boolean];
	queueIdentify: [number];
}

export type SMState = {
	onEnter: Array<(event: string) => unknown>;
	onLeave: Array<(event: string) => unknown>;
	transitions: Map<string, SMTransition>;
}

export type SMTransition = {
	destination: string;
	onTransition?: Array<(...args: any[]) => unknown>;
}

export type SMHistory = {
	from: string;
	event: string;
	to: string;
	time: number;
}
