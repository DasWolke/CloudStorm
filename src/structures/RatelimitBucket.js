'use strict';

/**
 * RatelimitBucket, used for ratelimiting the execution of functions
 * @property {Array} fnQueue - array of functions waiting to be executed
 * @property {Number} limit - Number of functions that may be executed during the timeframe set in limitReset
 * @property {Number} remaining - Remaining amount of executions during the current timeframe
 * @property {Number} limitReset - Timeframe in milliseconds until the ratelimit resets
 * @property {Object} resetTimeout - Timeout that calls the reset function once the timeframe passed
 * @private
 */
class RatelimitBucket {
    /**
     * Create a new Bucket
     * @param {Number} [limit=5] - Number of functions that may be executed during the timeframe set in limitReset
     * @param {Number} [limitReset=5000] - Timeframe in milliseconds until the ratelimit resets
     * @private
     */
    constructor(limit = 5, limitReset = 5000) {
        this.fnQueue = [];
        this.limit = limit;
        this.remaining = limit;
        this.limitReset = limitReset;
        this.resetTimeout = null;
    }

    /**
     * Queue a function to be executed
     * @param {Function} fn - function to be executed
     * @returns {Promise.<void>} - Result of the function if any
     * @protected
     */
    queue(fn) {
        return new Promise((res, rej) => {
            let wrapFn = () => {
                this.remaining--;
                if (!this.resetTimeout) {
                    this.resetTimeout = setTimeout(() => this.resetRemaining(), this.limitReset);
                }
                if (this.remaining !== 0) {
                    this.checkQueue();
                }
                if (typeof fn.then === 'function') {
                    return fn().then(res).catch(rej);
                }
                return res(fn());
            };
            if (this.remaining === 0) {
                this.fnQueue.push({
                    fn, callback: wrapFn
                });
                this.checkQueue();
            } else {
                wrapFn();
            }
        });
    }

    /**
     * Check if there are any functions in the queue that haven't been executed yet
     * @protected
     */
    checkQueue() {
        if (this.fnQueue.length > 0 && this.remaining !== 0) {
            let queuedFunc = this.fnQueue.splice(0, 1)[0];
            queuedFunc.callback();
        }
    }

    /**
     * Reset the remaining tokens to the base limit
     * @protected
     */
    resetRemaining() {
        this.remaining = this.limit;
        clearTimeout(this.resetTimeout);
        this.checkQueue();
    }

    /**
     * Clear the current queue of events to be sent
     * @protected
     */
    dropQueue() {
        this.fnQueue = [];
    }
}

module.exports = RatelimitBucket;
