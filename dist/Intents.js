"use strict";
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
const privileged = flags.GUILD_MEMBERS | flags.GUILD_PRESENCES;
const all = Object.values(flags).reduce((acc, p) => acc | p, 0);
const non_privileged = all & ~privileged;
function resolve(bit = 0) {
    if (typeof bit === "number" && bit >= 0)
        return bit;
    if (typeof bit === "string")
        return flags[bit] | 0;
    if (Array.isArray(bit))
        return bit.map((p) => resolve(p)).reduce((prev, p) => prev | p, 0);
    const error = new RangeError("BITFIELD_INVALID");
    throw error;
}
module.exports = {
    flags,
    all,
    privileged,
    non_privileged,
    resolve
};
