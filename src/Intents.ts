"use strict";

export const flags = {
	GUILDS: 1 << 0,
	GUILD_MEMBERS: 1 << 1,
	GUILD_BANS: 1 << 2,
	GUILD_EMOJIS_AND_STICKERS: 1 << 3,
	GUILD_INTEGRATIONS: 1 << 4,
	GUILD_WEBHOOKS: 1 << 5,
	GUILD_INVITES: 1 << 6,
	GUILD_VOICE_STATES: 1 << 7,
	GUILD_PRESENCES: 1 << 8,
	GUILD_MESSAGES: 1 << 9,
	GUILD_MESSAGE_REACTIONS: 1 << 10,
	GUILD_MESSAGE_TYPING: 1 << 11,
	DIRECT_MESSAGES: 1 << 12,
	DIRECT_MESSAGE_REACTIONS: 1 << 13,
	DIRECT_MESSAGE_TYPING: 1 << 14,
	MESSAGE_CONTENT: 1 << 15,
	GUILD_SCHEDULED_EVENTS: 1 >> 16
};

export const privileged = flags.GUILD_MEMBERS | flags.GUILD_PRESENCES | flags.MESSAGE_CONTENT;

export const all = Object.values(flags).reduce((acc, p) => acc | p, 0);

export const non_privileged = all & ~privileged;

export function resolve(bit: import("./Types").IntentResolvable = 0): number {
	if (typeof bit === "number" && bit >= 0) return bit;
	if (typeof bit === "string" && flags[bit]) return flags[bit] | 0;
	if (Array.isArray(bit)) return bit.map((p: import("./Types").IntentResolvable) => resolve(p)).reduce((prev, p) => prev | p, 0);
	throw new RangeError("BITFIELD_INVALID");
}

export default exports as typeof import("./Intents");
