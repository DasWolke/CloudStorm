"use strict";

/**
 * RatelimitBucket, used for ratelimiting the execution of functions
 */
class RatelimitBucket {
	public fnQueue: Array<{ fn: (...args: Array<any>) => any, callback: () => any }>;
	public limit: number;
	public remaining: number;
	public limitReset: number;
	public resetTimeout: NodeJS.Timeout | null;

	/**
	 * Create a new Bucket
	 * @param limit Number of functions that may be executed during the timeframe set in limitReset
	 * @param limitReset Timeframe in milliseconds until the ratelimit resets
	 */
	public constructor(limit: number = 5, limitReset: number = 5000) {
		this.fnQueue = [];
		this.limit = limit;
		this.remaining = limit;
		this.limitReset = limitReset;
		this.resetTimeout = null;
	}

	/**
	 * Queue a function to be executed
	 * @param fn function to be executed
	 * @returns Result of the function if any
	 */
	public queue(fn: (...args: Array<any>) => any): Promise<any> {
		return new Promise((res, rej) => {
			let wrapFn = () => {
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
			} else {
				wrapFn();
			}
		});
	}

	/**
	 * Check if there are any functions in the queue that haven't been executed yet
	 */
	private checkQueue() {
		if (this.fnQueue.length > 0 && this.remaining !== 0) {
			let queuedFunc = this.fnQueue.splice(0, 1)[0];
			queuedFunc.callback();
		}
	}

	/**
	 * Reset the remaining tokens to the base limit
	 */
	private resetRemaining() {
		this.remaining = this.limit;
		if (this.resetTimeout) clearTimeout(this.resetTimeout);
		this.checkQueue();
	}

	/**
	 * Clear the current queue of events to be sent
	 */
	public dropQueue() {
		this.fnQueue = [];
	}
}

export = RatelimitBucket;
