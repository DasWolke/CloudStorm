import Constants from "./Constants";

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
	op: typeof Constants["GATEWAY_OP_CODES"][keyof typeof Constants.GATEWAY_OP_CODES];
	d?: any;
	s?: number;
	t?: string;
}

export interface IGatewayMessage extends IWSMessage {
	shard_id: number;
}

export interface IPresenceActivity {
	name: string;
	type?: 0 | 1 | 2 | 3 | 5;
	url?: string;
}

export interface IPresence {
	status?: "online" | "idle" | "dnd" | "offline";
	afk?: boolean;
	since?: boolean;
	activities?: Array<IPresenceActivity> | null;
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
