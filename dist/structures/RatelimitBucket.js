"use strict";
class RatelimitBucket {
    constructor(limit = 5, limitReset = 5000) {
        this.fnQueue = [];
        this.limit = limit;
        this.remaining = limit;
        this.limitReset = limitReset;
        this.resetTimeout = null;
    }
    queue(fn) {
        return new Promise((res, rej) => {
            const wrapFn = () => {
                this.remaining--;
                if (!this.resetTimeout) {
                    this.resetTimeout = setTimeout(() => this.resetRemaining(), this.limitReset);
                }
                if (this.remaining !== 0) {
                    this.checkQueue();
                }
                if (fn instanceof Promise) {
                    return fn.then(res).catch(rej);
                }
                return res(fn());
            };
            if (this.remaining === 0) {
                this.fnQueue.push({
                    fn, callback: wrapFn
                });
                this.checkQueue();
            }
            else {
                wrapFn();
            }
        });
    }
    checkQueue() {
        if (this.fnQueue.length > 0 && this.remaining !== 0) {
            const queuedFunc = this.fnQueue.splice(0, 1)[0];
            queuedFunc.callback();
        }
    }
    resetRemaining() {
        this.remaining = this.limit;
        if (this.resetTimeout) {
            clearTimeout(this.resetTimeout);
            this.resetTimeout = null;
        }
        this.checkQueue();
    }
    dropQueue() {
        this.fnQueue = [];
    }
}
module.exports = RatelimitBucket;
