export interface IntentFlags {
	GUILDS: number;
	GUILD_MEMBERS: number;
	GUILD_BANS: number;
	GUILD_EMOJIS_AND_STICKERS: number;
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
	op: import("discord-typings").GatewayOpcode;
	d?: any;
	s?: number;
	t?: import("discord-typings").GatewayEvent;
}

export interface IGatewayMessage extends IWSMessage {
	shard_id: number;
}

export interface IClientOptions {
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
	reconnect?: boolean;
	initialPresence?: import("discord-typings").GatewayPresenceUpdate;
	intents?: IntentResolvable;
	snowtransferInstance?: import("snowtransfer").SnowTransfer;
	ws?: IClientWSOptions;
}
export interface IClientWSOptions {
	compress?: boolean;
	encoding?: "etf" | "json";
}
