"use strict";

/**
 * Numeric websocket intents. All available properties:
 * * `GUILDS`
 * * `GUILD_MEMBERS`
 * * `GUILD_BANS`
 * * `GUILD_EMOJIS`
 * * `GUILD_INTEGRATIONS`
 * * `GUILD_WEBHOOKS`
 * * `GUILD_INVITES`
 * * `GUILD_VOICE_STATES`
 * * `GUILD_PRESENCES`
 * * `GUILD_MESSAGES`
 * * `GUILD_MESSAGE_REACTIONS`
 * * `GUILD_MESSAGE_TYPING`
 * * `DIRECT_MESSAGES`
 * * `DIRECT_MESSAGE_REACTIONS`
 * * `DIRECT_MESSAGE_TYPING`
 * @see {@link https://discord.com/developers/docs/topics/gateway#list-of-intents}
 */
const flags = {
	GUILDS: 1 << 0,
	GUILD_MEMBERS: 1 << 1,
	GUILD_BANS: 1 << 2,
	GUILD_EMOJIS: 1 << 3,
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
};

/**
 * Bitfield representing all privileged intents
 * @see {@link https://discord.com/developers/docs/topics/gateway#privileged-intents}
 */
const privileged: number = flags.GUILD_MEMBERS | flags.GUILD_PRESENCES;

/**
 * Bitfield representing all intents combined
 */
const all: number = Object.values(flags).reduce((acc, p) => acc | p, 0);

/**
 * Bitfield representing all non-privileged intents
 */
const non_privileged: number = all & ~privileged;

/**
 * Resolves bitfields to their numeric form.
 * @param bit bit(s) to resolve
 */
function resolve(bit: import("./Types").IntentResolvable = 0): number {
	if (typeof bit === "number" && bit >= 0) return bit;
	if (typeof bit === "string") return flags[bit] | 0;
	// @ts-ignore
	if (Array.isArray(bit)) return bit.map(p => resolve(p)).reduce((prev, p) => prev | p, 0);
	const error = new RangeError("BITFIELD_INVALID");
	throw error;
}


export = {
	flags,
	all,
	privileged,
	non_privileged,
	resolve
};
