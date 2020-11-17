/// <reference types="node" />
import { EventEmitter } from "events";
import DiscordConnector from "./connector/DiscordConnector";
interface ShardEvents {
    disconnect: [number, string, boolean, boolean];
    error: [string];
    ready: [boolean];
    queueIdentify: [number];
}
declare class Shard extends EventEmitter {
    id: number;
    client: import("./Client");
    forceIdentify: boolean;
    ready: boolean;
    connector: DiscordConnector;
    constructor(id: number, client: import("./Client"));
    emit<E extends keyof ShardEvents>(event: E, ...args: ShardEvents[E]): boolean;
    once<E extends keyof ShardEvents>(event: E, listener: (...args: ShardEvents[E]) => any): this;
    on<E extends keyof ShardEvents>(event: E, listener: (...args: ShardEvents[E]) => any): this;
    get latency(): number;
    connect(): void;
    disconnect(): Promise<void>;
    presenceUpdate(data: import("./Types").IPresence): Promise<void>;
    voiceStateUpdate(data: import("./Types").IVoiceStateUpdate): Promise<void>;
    requestGuildMembers(data: import("./Types").IRequestGuildMembers): Promise<void>;
}
export = Shard;
