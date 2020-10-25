/// <reference types="node" />
import { EventEmitter } from "events";
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
    once<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => any): any;
    on<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => any): any;
    static get Constants(): {
        GATEWAY_OP_CODES: {
            DISPATCH: number;
            HEARTBEAT: number;
            IDENTIFY: number;
            STATUS_UPDATE: number;
            VOICE_STATE_UPDATE: number;
            VOICE_SERVER_PING: number;
            RESUME: number;
            RECONNECT: number;
            REQUEST_GUILD_MEMBERS: number;
            INVALID_SESSION: number;
            HELLO: number;
            HEARTBEAT_ACK: number;
        };
        GATEWAY_VERSION: number;
    };
    connect(): Promise<void>;
    getGateway(): Promise<string>;
    getGatewayBot(): Promise<any>;
    disconnect(): void;
    statusUpdate(data: import("./Types").IPresence): Promise<void>;
    shardStatusUpdate(shardId: number, data: import("./Types").IPresence): Promise<void>;
    voiceStateUpdate(shardId: number, data: import("./Types").IVoiceStateUpdate): Promise<void>;
    requestGuildMembers(shardId: number, data: import("./Types").IRequestGuildMembers): Promise<void>;
    private _updateEndpoint;
}
export = Client;
