/**
 * Emit without letting a throwing listener get into the lib's own handling, where it could leave a shard half-ready,
 * skip a state transition or read as malformed data and cost the connection. The throw goes to onThrow instead.
 * @since 0.20.0
 */
export function safeEmit(onThrow: (error: Error) => void, emit: () => unknown): void {
	try {
		emit();
	} catch (e) {
		onThrow(e instanceof Error ? e : new Error(String(e)));
	}
}

/**
 * For an error listener that throws: there is nobody left to report to, so the throw becomes an uncaught exception
 * raised away from the lib's own call stack, where it can't cut a state transition or a read loop short.
 * @since 0.20.0
 */
export function rethrowLater(error: Error): void {
	queueMicrotask(() => {
		throw error;
	});
}

/**
 * Emit an error on the client if anyone listens for them, otherwise degrade to a debug event.
 * @since 0.20.0
 */
export function clientError(client: import("./Client"), error: Error, prefix = ""): void {
	if (client.listenerCount("error")) safeEmit(rethrowLater, () => client.emit("error", error));
	else safeEmit(() => void 0, () => client.emit("debug", `${prefix}unlistened error: ${error.message}`));
}
