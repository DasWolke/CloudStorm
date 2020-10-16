import { EventEmitter } from "events";
import * as WebSocket from "ws";
import { ClientOptions as IWSOptions } from "ws";

export interface IntentFlags {
	GUILDS: number;
	GUILD_MEMBERS: number;
	GUILD_BANS: number;
	GUILD_EMOJIS: number;
	GUILD_INTEGRATIONS: number;
	GUILD_WEBHOOKS: number;
	GUILD_INVITES: number;
	GUILD_VOICE_STATES: number;
	GUILD_PRESENCES: number;
	GUILD_MESSAGES: number;
	GUILD_MESSAGE_REACTIONS: number;
	GUILD_MESSAGE_TYPING: number
	DIRECT_MESSAGES: number;
	DIRECT_MESSAGE_REACTIONS: number
	DIRECT_MESSAGE_TYPING: number;
}

export type IntentResolvable = number | Array<number> | keyof IntentFlags | Array<keyof IntentFlags>;

export interface IWSMessage {
	op: number;
	d?: { [key: string]: any };
	s?: number;
}

export interface IPresenceGame {
	name: string;
	type?: number;
	url?: string;
}

export interface IPresence {
	status?: string;
	afk?: boolean;
	since?: boolean;
	game?: IPresenceGame;
}

export interface IClientOptions {
	largeGuildThreshold?: number;
	firstShardId?: number;
	lastShardId?: number;
	shardAmount?: number;
	reconnect?: boolean;
	initialPresence?: IPresence;
	intents?: IntentResolvable;
}

export interface IVoiceStateUpdate {
	guild_id: string;
	channel_id: string | null;
	self_mute: boolean;
	self_deaf: boolean;
}

export interface IRequestGuildMembers {
	guild_id: string;
	query: string | null;
	limit: number;
}

export interface IShardReady {
	id: number;
	ready: boolean;
}

export interface GATEWAY_OP_CODES {
	DISPATCH: number;
	HEARTBEAT: number;
	IDENTIFY: number;
	STATUS_UPDATE: number;
	VOICE_STATE_UPDATE: number;
	VOICE_SERVER_PING: number;
	RESUME: number;
	RECONNECT: number;
	REQUEST_GUILD_MEMBERS: number;
	INVALID_SESSION: number;
	HELLO: number
	HEARTBEAT_ACK: number;
}

export const GATEWAY_VERSION: number;

export class RatelimitBucket {
	private fnQueue: Function[];
	private limit: number;
	private remaining: number;
	private limitReset: number;
	private resetTimeout: NodeJS.Timer | null;
	public constructor(limit?: number, limitReset?: number);
	protected queue<T extends Function>(fn: T): Promise<void>;
	protected checkQueue(): void;
	protected resetRemaining(): void;
	protected dropQueue(): void;
}

export class BetterWs extends EventEmitter {
	private ws: WebSocket;
	private wsBucket: RatelimitBucket;
	private statusBucket: RatelimitBucket;
	private zlibInflate: any; // TODO: set type
	public constructor(address: string, protocols: string[], options: IWSOptions);
	protected get rawWs(): WebSocket;
	protected bindWs(ws: WebSocket): void;
	protected recreateWs(address: string, options?: IWSOptions): void;
	protected onOpen(): void;
	protected onMessage(message: string | Buffer | { [key: string]: any }): void;
	protected onClose(code: number, reason: string): void;
	protected sendMessage(data: { [key: string]: any }): Promise<void>;
	protected close(code?: number, reason?: string): Promise<void>;
	public on(event: "error", cb: (data: Error | string) => void): this;
	public on(event: "ws_open", cb: () => void): this;
	public on(event: "ws_message", cb: (data: { [key: string]: any }) => void): this;
	public on(event: "ws_close", cb: (code: number, reason: string) => void): this;
	public once(event: "error", cb: (data: Error | string) => void): this;
	public once(event: "ws_open", cb: () => void): this;
	public once(event: "ws_message", cb: (data: { [key: string]: any }) => void): this;
	public once(event: "ws_close", cb: (code: number, reason: String) => void): this;
}

export class DiscordConnector extends EventEmitter { // TODO: add events
	public id: number;
	public client: Client;
	public options: IClientOptions;
	public reconnect: boolean;
	public betterWs: BetterWs | null;
	public heartbeatInterval: number | null;
	public seq: number;
	public status: string;
	public sessionId: number | null;
	public forceIdentify: boolean;
	public constructor(id: number, client: Client);
	protected connect(): void;
	protected disconnect(): Promise<void>;
	protected messageAction(message: IWSMessage): void;
	protected reset(): void;
	protected identify(force?: boolean): Promise<void>;
	protected resume(): Promise<void>;
	protected heartbeat(): void;
	protected handleDispatch(message: IWSMessage): void;
	protected handleWsClose(code: number, reason: string): void;
	protected statusUpdate(data?: IPresence): void;
	protected requestGuildMembers(data?: IRequestGuildMembers): Promise<void>;
	private _checkPresenceData(data: IPresence): IPresence;
	private _checkVoiceStateUpdateData(data: IVoiceStateUpdate): IVoiceStateUpdate;
	private _checkRequestGuildMembersData(data: IRequestGuildMembers): IRequestGuildMembers;
	public on(event: "queueIdentify", cb: (data: number) => void): this;
	public once(event: "queueIdentify", cb: (data: number) => void): this;
	public on(event: "event", cb: (data: IWSMessage) => void): this;
	public once(event: "event", cb: (data: IWSMessage) => void): this;
	public on(event: "ready", cb: (data: boolean) => void): this;
	public once(event: "ready", cb: (data: boolean) => void): this;
	public on(event: "error", cb: (data: Error | string) => void): this;
	public once(event: "error", cb: (data: Error | string) => void): this;
}

export class Shard extends EventEmitter {
	public client: Client;
	public id: number;
	public forceIdentify: boolean;
	public ready: boolean;
	public connector: DiscordConnector;
	public constructor(id: number, client: Client);
	public on(event: "disconnect", cb: () => void): this;
	public on(event: "ready", cb: (data: boolean) => void): this;
	public on(event: "error", cb: (data: Error) => void): this;
	public on(event: "queueIdentify", cb: (data: number) => void): this;
	public once(event: "disconnect", cb: () => void): this;
	public once(event: "ready", cb: (data: boolean) => void): this;
	public once(event: "error", cb: (data: Error) => void): this;
	public once(event: "queueIdentify", cb: (data: number) => void): this;
	protected connect(): void;
	protected disconnect(): Promise<void>;
	protected statusUpdate(data: IPresence): Promise<void>;
	protected voiceStateUpdate(data: IVoiceStateUpdate): Promise<void>;
	protected requestGuildMembers(data: IRequestGuildMembers): Promise<void>;
}

export class ShardManager {
	public client: Client;
	public options: IClientOptions;
	public connectQueueInterval: NodeJS.Timer;
	public shards: { [key: number]: Shard };
	public connectQueue: Shard[];
	public lastConnectAttempt: Date;
	public constructor(client: Client);
	private _connectShard(data: { action: string; shard: Shard }): void;
	private _checkQueue(): void;
	private _addListener(shard: Shard): void;
	private _checkReady(): void;
	private _checkDisconnect(): void;
	protected spawn(): void;
	protected disconnect(): void;
	protected statusUpdate(data?: IPresence): void;
	protected shardStatusUpdate(shardId: number, data?: IPresence): void;
	protected voiceStateUpdate(shardId: number, data: IVoiceStateUpdate): Promise<void>;
	protected requestGuildMembers(shardId: number, data: IRequestGuildMembers): Promise<void>;
}

export class Client extends EventEmitter { // TODO: add events
	public token: string;
	public httpToken: string;
	public shardManager: ShardManager;
	public options: IClientOptions;
	public constructor(token: string, options?: IClientOptions);
	public connect(): Promise<void>;
	public getGateway(): Promise<string>;
	public getGatewayBot(): Promise<any>;
	public disconnect(): void;
	public statusUpdate(data: IPresence): void;
	public shardStatusUpdate(shardId: number, data: IPresence): Promise<void>;
	public voiceStateUpdate(shardId: number, data: IVoiceStateUpdate): Promise<void>;
	public requestGuildMembers(shardId: number, data: IRequestGuildMembers): Promise<void>;
	public on(event: "disconnected", cb: () => void): this;
	public once(event: "disconnected", cb: () => void): this;
	public on(event: "dispatch", cb: (data: { [key: string]: any }) => void): this;
	public once(event: "dispatch", cb: (data: { [key: string]: any }) => void): this;
	public on(event: "error", cb: (data: Error) => void): this;
	public once(event: "error", cb: (data: Error) => void): this;
	public on(event: "event", cb: (data: { [key: string]: any }) => void): this; // TODO: make interfaces for all events
	public once(event: "event", cb: (data: { [key: string]: any }) => void): this; // TODO: ^
	public on(event: "rawRecieve", cb: (data: { [key: string]: any }) => void): this;
	public once(event: "rawRecieve", cb: (data: { [key: string]: any }) => void): this;
	public on(event: "rawSend", cb: (data: { [key: string]: any }) => void): this;
	public once(event: "rawSend", cb: (data: { [key: string]: any }) => void): this;
	public on(event: "ready", cb: () => void): this;
	public once(event: "ready", cb: () => void): this;
	public on(event: "shardReady", cb: (data: IShardReady) => void): this;
	public once(event: "shardReady", cb: (data: IShardReady) => void): this;
	public on(event: "voiceStateUpdate", cb: (data: IVoiceStateUpdate) => void): this;
	public once(event: "voiceStateUdpate", cb: (data: IVoiceStateUpdate) => void): this;
	public on(event: "debug", cb: (data: string) => void): this;
	public once(event: "debug", cb: (data: string) => void): this;
}
