/// <reference types="node" />
import { EventEmitter } from "events";
import Constants from "./Constants";
import ShardManager from "./ShardManager";
interface ClientEvents {
    debug: [string];
    rawSend: [import("./Types").IWSMessage];
    rawReceive: [import("./Types").IGatewayMessage];
    event: [import("./Types").IGatewayMessage];
    dispatch: [import("./Types").IGatewayMessage];
    voiceStateUpdate: [import("./Types").IGatewayMessage];
    shardReady: [{
        id: number;
        ready: boolean;
    }];
    error: [string];
    ready: [];
    disconnected: [];
}
declare class Client extends EventEmitter {
    token: string;
    options: import("./Types").IClientOptions & {
        token: string;
        endpoint?: string;
    };
    shardManager: ShardManager;
    version: any;
    private _restClient;
    constructor(token: string, options?: import("./Types").IClientOptions);
    emit<E extends keyof ClientEvents>(event: E, ...args: ClientEvents[E]): boolean;
    once<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => any): this;
    on<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => any): this;
    static get Constants(): typeof Constants;
    connect(): Promise<void>;
    getGateway(): Promise<string>;
    getGatewayBot(): Promise<any>;
    disconnect(): void;
    presenceUpdate(data: import("./Types").IPresence): Promise<void>;
    shardStatusUpdate(shardId: number, data: import("./Types").IPresence): Promise<void>;
    voiceStateUpdate(shardId: number, data: import("./Types").IVoiceStateUpdate): Promise<void>;
    requestGuildMembers(shardId: number, data: import("./Types").IRequestGuildMembers): Promise<void>;
    private _updateEndpoint;
}
export = Client;
