declare function resolve(bit?: import("./Types").IntentResolvable): number;
declare const _default: {
    flags: {
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
        GUILD_MESSAGE_TYPING: number;
        DIRECT_MESSAGES: number;
        DIRECT_MESSAGE_REACTIONS: number;
        DIRECT_MESSAGE_TYPING: number;
    };
    all: number;
    privileged: number;
    non_privileged: number;
    resolve: typeof resolve;
};
export = _default;
