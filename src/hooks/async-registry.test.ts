import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncHookRegistry } from "./async-registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
	promise: Promise<unknown>,
	abort: () => void = vi.fn(),
	command = "test-command",
	startedAt = Date.now(),
) {
	return { command, startedAt, promise, abort };
}

function deferredPromise<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AsyncHookRegistry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// --- registration -------------------------------------------------------

	it("starts with zero pending entries", () => {
		const registry = new AsyncHookRegistry();
		expect(registry.pendingCount).toBe(0);
	});

	it("increments pendingCount on register and decrements when promise settles", async () => {
		const registry = new AsyncHookRegistry();
		const deferred = deferredPromise();

		registry.register(makeEntry(deferred.promise));
		expect(registry.pendingCount).toBe(1);

		deferred.resolve(undefined);
		await deferred.promise.catch((_e) => _e);
		// Allow the .finally() cleanup microtask to run.
		await Promise.resolve();

		expect(registry.pendingCount).toBe(0);
	});

	it("decrements pendingCount when promise rejects", async () => {
		const registry = new AsyncHookRegistry();
		const deferred = deferredPromise();

		registry.register(makeEntry(deferred.promise));
		expect(registry.pendingCount).toBe(1);

		deferred.reject(new Error("hook failed"));
		// Swallow unhandled rejection from the original deferred.
		await deferred.promise.catch((_e) => _e);
		await Promise.resolve();

		expect(registry.pendingCount).toBe(0);
	});

	it("returns incrementing IDs", () => {
		const registry = new AsyncHookRegistry();
		const id1 = registry.register(makeEntry(Promise.resolve()));
		const id2 = registry.register(makeEntry(Promise.resolve()));
		expect(id1).toBe(1);
		expect(id2).toBe(2);
	});

	it("tracks multiple concurrent entries", () => {
		const registry = new AsyncHookRegistry();
		const d1 = deferredPromise();
		const d2 = deferredPromise();

		registry.register(makeEntry(d1.promise));
		registry.register(makeEntry(d2.promise));

		expect(registry.pendingCount).toBe(2);
	});

	// --- pendingEntries -----------------------------------------------------

	it("pendingEntries returns command and startedAt for each in-flight hook", () => {
		const registry = new AsyncHookRegistry();
		const deferred = deferredPromise();
		const now = Date.now();

		registry.register(makeEntry(deferred.promise, vi.fn(), "notify-slack.sh", now));

		const entries = registry.pendingEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ id: 1, command: "notify-slack.sh", startedAt: now });
	});

	it("pendingEntries snapshot is not affected by later registrations", () => {
		const registry = new AsyncHookRegistry();
		const d1 = deferredPromise();
		const d2 = deferredPromise();

		registry.register(makeEntry(d1.promise, vi.fn(), "cmd-a"));
		const snap = registry.pendingEntries();

		registry.register(makeEntry(d2.promise, vi.fn(), "cmd-b"));

		expect(snap).toHaveLength(1);
		expect(registry.pendingEntries()).toHaveLength(2);
	});

	// --- drain --------------------------------------------------------------

	it("drain resolves immediately when there are no pending hooks", async () => {
		const registry = new AsyncHookRegistry();
		await expect(registry.drain()).resolves.toBeUndefined();
	});

	it("drain resolves when all hooks settle before the timeout", async () => {
		const registry = new AsyncHookRegistry();
		const d1 = deferredPromise();
		const d2 = deferredPromise();

		registry.register(makeEntry(d1.promise));
		registry.register(makeEntry(d2.promise));

		// Resolve both before the drain timeout fires.
		d1.resolve(undefined);
		d2.resolve(undefined);

		await expect(registry.drain(1_000)).resolves.toBeUndefined();
	});

	it("drain calls cancel when the timeout fires before all hooks settle", async () => {
		const registry = new AsyncHookRegistry();
		const abort = vi.fn();
		const never = new Promise<void>(() => {
			/* never resolves — used to test drain timeout */
		});

		registry.register(makeEntry(never, abort));

		const drainPromise = registry.drain(500);

		// Advance past the drain timeout.
		await vi.advanceTimersByTimeAsync(500);

		await drainPromise;

		expect(abort).toHaveBeenCalledOnce();
	});

	it("drain does not call cancel when hooks settle before the timeout", async () => {
		const registry = new AsyncHookRegistry();
		const abort = vi.fn();
		const deferred = deferredPromise();

		registry.register(makeEntry(deferred.promise, abort));

		const drainPromise = registry.drain(500);

		// Settle the hook before the timeout.
		deferred.resolve(undefined);
		await deferred.promise;
		await Promise.resolve(); // flush .finally cleanup

		// Advance timers — timeout should have been cleared; cancel should NOT fire.
		await vi.advanceTimersByTimeAsync(600);

		await drainPromise;

		expect(abort).not.toHaveBeenCalled();
	});

	// --- cancel -------------------------------------------------------------

	it("cancel calls abort on all pending entries", () => {
		const registry = new AsyncHookRegistry();
		const abort1 = vi.fn();
		const abort2 = vi.fn();

		registry.register(
			makeEntry(
				new Promise<void>(() => {
					/* never resolves */
				}),
				abort1,
			),
		);
		registry.register(
			makeEntry(
				new Promise<void>(() => {
					/* never resolves */
				}),
				abort2,
			),
		);

		registry.cancel();

		expect(abort1).toHaveBeenCalledOnce();
		expect(abort2).toHaveBeenCalledOnce();
	});

	it("cancel is a no-op when there are no pending entries", () => {
		const registry = new AsyncHookRegistry();
		expect(() => registry.cancel()).not.toThrow();
	});

	it("cancel does not affect entries that already settled", async () => {
		const registry = new AsyncHookRegistry();
		const abort = vi.fn();
		const settled = Promise.resolve();

		registry.register(makeEntry(settled, abort));

		// Wait for the .finally cleanup.
		await settled;
		await Promise.resolve();

		registry.cancel();

		expect(abort).not.toHaveBeenCalled();
	});
});
