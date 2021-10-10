"use strict";

/**
 * RatelimitBucket, used for ratelimiting the execution of functions.
 */
class RatelimitBucket {
	public fnQueue: Array<{ fn: (...args: Array<any>) => any, callback: () => any; error: Error }>;
	public limit: number;
	public remaining: number;
	public limitReset: number;
	public resetTimeout: NodeJS.Timeout | null;

	/**
	 * Create a new Bucket.
	 * @param limit Number of functions that may be executed during the timeframe set in limitReset.
	 * @param limitReset Timeframe in milliseconds until the ratelimit resets.
	 */
	public constructor(limit = 5, limitReset = 5000) {
		this.fnQueue = [];
		this.limit = limit;
		this.remaining = limit;
		this.limitReset = limitReset;
		this.resetTimeout = null;
	}

	/**
	 * Queue a function to be executed.
	 * @param fn Function to be executed.
	 * @returns Result of the function if any.
	 */
	public queue(fn: (...args: Array<any>) => any): Promise<any> {
		// More debug-ability
		const error = new Error("An Error occurred in the bucket queue");
		return new Promise((res, rej) => {
			const wrapFn = () => {
				this.remaining--;
				if (!this.resetTimeout) {
					this.resetTimeout = setTimeout(() => {
						try {
							this.resetRemaining();
						} catch (e) {
							rej(e);
						}
					}, this.limitReset);
				}
				if (this.remaining !== 0) {
					this.checkQueue().catch(rej);
				}
				if (fn instanceof Promise) {
					return fn.then(res).catch((e) => {
						if (e) {
							e.stack = error.stack;
							return rej(e);
						} else return rej(error);
					});
				}
				return res(fn());
			};
			if (this.remaining === 0) {
				this.fnQueue.push({
					fn, callback: wrapFn, error
				});
				this.checkQueue().catch(rej);
			} else {
				wrapFn();
			}
		});
	}

	/**
	 * Check if there are any functions in the queue that haven't been executed yet.
	 */
	private async checkQueue(): Promise<void> {
		if (this.fnQueue.length > 0 && this.remaining !== 0) {
			const queuedFunc = this.fnQueue.splice(0, 1)[0];
			try {
				queuedFunc.callback();
			} catch (e) {
				if (e) {
					e.stack = queuedFunc.error.stack;
					throw e;
				} else throw queuedFunc.error;
			}
		}
	}

	/**
	 * Reset the remaining tokens to the base limit.
	 */
	private resetRemaining(): void {
		this.remaining = this.limit;
		if (this.resetTimeout) {
			clearTimeout(this.resetTimeout);
			this.resetTimeout = null;
		}
		this.checkQueue();
	}

	/**
	 * Clear the current queue of events to be sent.
	 */
	public dropQueue(): void {
		this.fnQueue = [];
	}
}

export = RatelimitBucket;
