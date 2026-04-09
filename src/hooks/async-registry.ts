import { DEFAULT_DRAIN_TIMEOUT_MS } from "./types";

/**
 * An in-flight async hook execution tracked by the registry.
 */
export interface AsyncHookEntry {
	/** Shell command string (for logging/auditing). */
	command: string;
	/** Epoch ms when the hook was dispatched. */
	startedAt: number;
	/** Promise that settles when the hook process exits or is killed. */
	promise: Promise<unknown>;
	/**
	 * Aborts the underlying hook process.  Sends SIGTERM immediately and
	 * SIGKILL after the force-kill grace period if the process has not exited.
	 */
	abort: () => void;
}

/**
 * Tracks pending fire-and-forget hook executions and provides
 * graceful-drain and cancel semantics for process shutdown.
 *
 * Lifecycle contract:
 * - Hooks dispatched with `async: true` are registered here instead of being
 *   awaited by `HookRunner`.
 * - On normal shutdown: call `drain(timeoutMs)` — the registry waits up to
 *   `timeoutMs` for all pending hooks to settle, then cancels survivors.
 * - On immediate shutdown: call `cancel()` — all pending hooks are aborted.
 *
 * A hook that finishes (success or failure) automatically deregisters itself.
 */
export class AsyncHookRegistry {
	private readonly entries = new Map<number, AsyncHookEntry>();
	private nextId = 0;

	/**
	 * Register an in-flight async hook execution.
	 *
	 * The entry is automatically removed from the registry when `promise`
	 * settles, regardless of outcome.
	 *
	 * @param entry In-flight execution data including promise and abort handle.
	 * @returns Numeric ID assigned to this entry (useful for testing).
	 */
	register(entry: AsyncHookEntry): number {
		const id = ++this.nextId;
		const tracked = entry.promise.finally(() => {
			this.entries.delete(id);
		});
		// Suppress unhandled-rejection: async hooks are fire-and-forget and their
		// errors are non-blocking.  drain() uses Promise.allSettled so it tolerates
		// rejected entries without needing to catch here.
		tracked.catch(() => {
			// intentional no-op
		});
		this.entries.set(id, { ...entry, promise: tracked });
		return id;
	}

	/**
	 * Number of hook executions currently in flight.
	 */
	get pendingCount(): number {
		return this.entries.size;
	}

	/**
	 * Snapshot of in-flight entries for logging and auditing.
	 * Returns a new array on each call; mutations do not affect the registry.
	 */
	pendingEntries(): Array<{ id: number; command: string; startedAt: number }> {
		return Array.from(this.entries.entries()).map(([id, e]) => ({
			id,
			command: e.command,
			startedAt: e.startedAt,
		}));
	}

	/**
	 * Wait for all pending hooks to settle.
	 *
	 * If all hooks complete before `drainTimeoutMs` the promise resolves
	 * cleanly.  If the timeout fires first, `cancel()` is called on surviving
	 * hooks and the promise resolves immediately (without waiting for the kill
	 * signals to propagate — the underlying processes will be SIGTERM/SIGKILLed
	 * by the abort path in `executeHookCommand`).
	 *
	 * @param drainTimeoutMs Maximum ms to wait before cancelling survivors.
	 *                       Defaults to `DEFAULT_DRAIN_TIMEOUT_MS` (5 000 ms).
	 */
	async drain(drainTimeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
		if (this.entries.size === 0) {
			return;
		}

		const pending = Array.from(this.entries.values()).map((e) => e.promise);

		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

		const timeoutRace = new Promise<void>((resolve) => {
			timeoutHandle = setTimeout(() => {
				this.cancel();
				resolve();
			}, drainTimeoutMs);
		});

		await Promise.race([
			Promise.allSettled(pending).then(() => {
				if (timeoutHandle !== undefined) {
					clearTimeout(timeoutHandle);
				}
			}),
			timeoutRace,
		]);
	}

	/**
	 * Abort all pending hook executions immediately.
	 *
	 * Each entry's `abort()` handler is called, which sends SIGTERM to the
	 * underlying hook process (SIGKILL follows after the force-kill grace
	 * period in `executeHookCommand`).
	 *
	 * This is a best-effort, non-awaited operation.  The entries remain in the
	 * registry until their promises settle after the kill signals propagate.
	 */
	cancel(): void {
		for (const entry of this.entries.values()) {
			entry.abort();
		}
	}
}

/**
 * Creates an `AsyncHookRegistry` instance.
 */
export function createAsyncHookRegistry(): AsyncHookRegistry {
	return new AsyncHookRegistry();
}
