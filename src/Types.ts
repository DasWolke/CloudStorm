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
	d?: any;
	s?: number;
	t?: string;
}

export interface IGatewayMessage extends IWSMessage {
	shard_id: number;
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
	game?: IPresenceGame | null;
}

export interface IClientOptions {
	largeGuildThreshold?: number;
	firstShardId?: number;
	lastShardId?: number;
	shardAmount?: number;
	reconnect?: boolean;
	initialPresence?: IPresence;
	intents?: IntentResolvable;
	connectQueueInterval?: number;
}

export interface IVoiceStateUpdate {
	guild_id: string;
	channel_id?: string | null;
	self_mute?: boolean;
	self_deaf?: boolean;
}

export interface IRequestGuildMembers {
	guild_id: string;
	query?: string | null;
	limit?: number;
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
