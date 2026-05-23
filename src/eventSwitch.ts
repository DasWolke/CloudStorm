import type { EventEmitter } from "events";

/**
 * Call with an emitter and an object of callbacks, and the first event to be emitted will call the callback.
 * If the callback returns a promise, waits for the promise to resolve or reject. eventSwitch will resolve or reject with the same value.
 * All added listeners are removed before eventSwitch returns.
 */
function eventSwitch(emitter: EventEmitter, signal: AbortSignal | null, cbs: { [eventName: string]: (...args: any[]) => any }): Promise<void> {
	const realListeners = new Map<string, (...args: Array<any>) => void>();
	return Promise.race(
		Object.entries(cbs).map(([event, cb]) => {
			return new Promise<void>((resolve, reject) => {
				const l = (...args: Array<any>) => (async () => cb(...args))().then(resolve, reject);
				realListeners.set(event, l);
				emitter.once(event, l);
			});
		}).concat(new Promise<void>((resolve, reject) => {
			signal?.throwIfAborted()
			signal?.addEventListener("abort", () => {
				reject(signal.reason)
			}, {once: true})
		}))
	).finally(() => {
		for (const [event, l] of realListeners.entries()) {
			emitter.removeListener(event, l);
		}
	});
}

export = eventSwitch
