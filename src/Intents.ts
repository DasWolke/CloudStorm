"use strict";

export type IntentFlags = typeof flags;
export type IntentResolvable = number | Array<number> | keyof IntentFlags | Array<keyof IntentFlags>;

/**
 * Bit flags representing Discord intents.
 */
export const flags = {
	GUILDS: 1 << 0,
	GUILD_MEMBERS: 1 << 1,
	GUILD_MODERATION: 1 << 2,
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
	GUILD_SCHEDULED_EVENTS: 1 << 16,
	AUTO_MODERATION_CONFIGURATION: 1 << 20,
	AUTO_MODERATION_EXECUTION: 1 << 21,
	GUILD_MESSAGE_POLLS: 1 << 24,
	DIRECT_MESSAGE_POLLS: 1 << 25
};

/** All bit flags that would require Discord to grant manually OR'd together. */
export const privileged = flags.GUILD_MEMBERS | flags.GUILD_PRESENCES | flags.MESSAGE_CONTENT;
/** All bit flags OR'd together. */
export const all = Object.values(flags).reduce((acc, p) => acc | p, 0);
/** All bit flags excluding those that would require Discord to grant manually OR'd together. */
export const non_privileged = all & ~privileged;

/**
 * A function to resolve either bit number(s) or human readable string(s) to a bit collection number Discord can accept as client intents.
 * @param bit Data representing intents that can be resolved to a bit collection number Discord can accept.
 * @returns A bit collection number Discord can accept as the client intents.
 */
export function resolve(bit: IntentResolvable = 0): number {
	if (typeof bit === "number" && bit >= 0) return bit;
	if (typeof bit === "string" && flags[bit]) return flags[bit] | 0;
	if (Array.isArray(bit)) return bit.map((p: IntentResolvable) => resolve(p)).reduce((prev, p) => prev | p, 0);
	throw new RangeError("BITFIELD_INVALID");
}

export default { flags, privileged, all, non_privileged, resolve };
