/// <reference types="node" />
declare class RatelimitBucket {
    fnQueue: Array<{
        fn: (...args: Array<any>) => any;
        callback: () => any;
    }>;
    limit: number;
    remaining: number;
    limitReset: number;
    resetTimeout: NodeJS.Timeout | null;
    constructor(limit?: number, limitReset?: number);
    queue(fn: (...args: Array<any>) => any): Promise<any>;
    private checkQueue;
    private resetRemaining;
    dropQueue(): void;
}
export = RatelimitBucket;
