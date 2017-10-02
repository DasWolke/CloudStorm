declare module "Cloudstorm" {
    import { EventEmitter } from "events";
    import * as WebSocket from "ws";
    import { IClientOptions as IWSOptions } from "ws";

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
        compress?: boolean;
        large_guild_threshold?: number;
        firstShardId?: number;
        lastShardId?: number;
        shardAmount?: number;
        reconnect?: boolean;
        initialPresence?: IPresence;
        connectQueueInterval?: boolean;
        endpoint?: string;
    }

    export class RatelimitBucket {
        public fnQueue: Function[];
        public limit: number;
        public remaining: number;
        public limitReset: number;
        public resetTimeout: NodeJS.Timer | null;
        public constructor(limit?: number, limitReset?: number);
        public queue<T extends Function>(fn: T): void;
    }

    export class BetterWs extends EventEmitter { // TODO: add events
        public ws: WebSocket;
        public wsBucket: RatelimitBucket;
        public constructor(address: string, protocols: string[], options: IWSOptions);
        public rawWs: WebSocket;
        public bindWs(ws: WebSocket): void;
        public recreateWs(address: string, protocols: string[], options: IWSOptions): void;
        public onOpen(): void;
        public onMessage(message: string): void;
        public onClose(code: number, reason: string): void;
        public sendMessage(data: { [key: string]: any }): Promise<void>;
        public close(code?: number, reason?: string): Promise<void>;
        public terminate(): void; // TODO wait for wolke to implement this
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
        public connect(): void;
        public messageAction(message: IWSMessage): void;
        public reset(): void;
        public identify(force?: boolean): void;
        public resume(): void;
        public heartbeat(): void;
        public handleDispatch(message: IWSMessage): void;
        public handleWsClose(code: number, reason: string): void;
        public statusUpdate(data?: IPresence): void;
        public checkPresenceData(data: IPresence): IPresence;
    }

    export class Shard {
        public client: Client;
        public id: number;
        public forceIdentify: boolean;
        public ready: boolean;
        public connector: DiscordConnector;
        public constructor(id: number, client: Client);
        public connect(): void;
        public statusUpdate(data: IPresence): void;
    }

    export class ShardManager {
        public client: Client;
        public options: IClientOptions;
        public connectQueueInterval: NodeJS.Timer;
        public shards: { [key: number]: Shard };
        public connectQueue: Shard[];
        public lastConnectAttempt: number | null;
        public constructor(client: Client);
        public spawn(): void;
        public connectShard(shard: Shard): void;
        public checkQueue(): void;
        public addListener(shard: Shard): void;
        public checkReady(): void;
        public statusUpdate(data?: IPresence): void;
    }

    export class Client extends EventEmitter { // TODO: add events
        public token: string;
        public httpToken: string;
        public shardManager: ShardManager;
        public options: IClientOptions;
        public constructor(token: string, options?: IClientOptions);
        public connect(): Promise<void>;
        public getGateway(): Promise<string>;
        public disconnect(): void; // TODO: wait for wolke to implement this
        public statusUpdate(data: IPresence): void;
    }
}