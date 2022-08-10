"use strict";

/**
 * RatelimitBucket, used for ratelimiting the execution of functions.
 */
class RatelimitBucket {
	public fnQueue: Array<{ fn: () => unknown, callback: () => unknown; error: Error }>;
	public limit: number;
	public remaining: number;
	public limitReset: number;
	public defaultReset: number | undefined;
	public resetTimeout: NodeJS.Timeout | null;

	public static readonly default = RatelimitBucket;

	/**
	 * Create a new Bucket.
	 * @param limit Number of functions that may be executed during the timeframe set in limitReset.
	 * @param limitReset Timeframe in milliseconds until the ratelimit resets.
	 * @param defaultLimit If the bucket info does not provide default values, but provides remaining, this is the limit to use after the initial reset.
	 * @param defaultReset If the bucket info does not provide default values, but provides remaining, this is the reset to use after the initial reset.
	 */
	public constructor(limit = 5, limitReset = 5000, defaultReset?: number) {
		this.fnQueue = [];
		this.limit = limit;
		this.remaining = limit;
		this.limitReset = limitReset;
		this.resetTimeout = null;
		this.defaultReset = defaultReset;
	}

	/**
	 * Queue a function to be executed.
	 * @param fn Function to be executed.
	 * @returns Result of the function if any.
	 */
	public queue<T>(fn: () => T): Promise<T> {
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
					}, this.limitReset).unref();
				}
				if (this.remaining !== 0) this.checkQueue().catch(rej);

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
				this.fnQueue.push({ fn, callback: wrapFn, error });
				this.checkQueue().catch(rej);
			} else wrapFn();
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
		if (this.defaultReset) this.limitReset = this.defaultReset;
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
