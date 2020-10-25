/// <reference types="node" />
import Shard from "./Shard";
declare class ShardManager {
    client: import("./Client");
    options: import("./Client")["options"];
    shards: {
        [id: number]: Shard;
    };
    connectQueue: Array<{
        action: string;
        shard: Shard;
    }>;
    lastConnectionAttempt: number | null;
    connectQueueInterval: NodeJS.Timeout;
    constructor(client: import("./Client"));
    spawn(): void;
    disconnect(): void;
    private _connectShard;
    private _checkQueue;
    private _addListener;
    private _checkReady;
    private _checkDisconnect;
    statusUpdate(data?: import("./Types").IPresence): Promise<void>;
    shardStatusUpdate(shardId: number, data?: import("./Types").IPresence): Promise<void>;
    voiceStateUpdate(shardId: number, data: import("./Types").IVoiceStateUpdate): Promise<void>;
    requestGuildMembers(shardId: number, data: import("./Types").IRequestGuildMembers): Promise<void>;
}
export = ShardManager;
