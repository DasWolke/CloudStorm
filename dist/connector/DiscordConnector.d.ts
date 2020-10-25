/// <reference types="node" />
import { EventEmitter } from "events";
import BetterWs from "../structures/BetterWs";
interface ConnectorEvents {
    queueIdentify: [number];
    event: [import("../Types").IWSMessage];
    ready: [boolean];
    error: [string];
    disconnect: [number, string, boolean, boolean];
}
declare class DiscordConnector extends EventEmitter {
    id: number;
    client: import("../Client");
    options: import("../Client")["options"];
    reconnect: boolean;
    betterWs: BetterWs | null;
    heartbeatInterval: NodeJS.Timeout | null;
    _trace: string | null;
    seq: number;
    status: string;
    sessionId: string | null;
    forceIdentify: boolean;
    constructor(id: number, client: import("../Client"));
    emit<E extends keyof ConnectorEvents>(event: E, ...args: ConnectorEvents[E]): boolean;
    once<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any): this;
    on<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any): this;
    connect(): void;
    disconnect(): Promise<void>;
    private messageAction;
    private reset;
    identify(force?: boolean): Promise<void>;
    private resume;
    private heartbeat;
    private handleDispatch;
    private handleWsClose;
    statusUpdate(data?: import("../Types").IPresence): Promise<void>;
    voiceStateUpdate(data: import("../Types").IVoiceStateUpdate): Promise<void>;
    requestGuildMembers(data: import("../Types").IRequestGuildMembers): Promise<void>;
    private _checkPresenceData;
    private _checkVoiceStateUpdateData;
    private _checkRequestGuildMembersData;
}
export = DiscordConnector;
