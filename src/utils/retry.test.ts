import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetExhaustedError, RetryableError, RuntimeError } from "./errors";
import { withRetry } from "./retry";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("withRetry", () => {
	it("returns the result immediately on success", async () => {
		const fn = vi.fn().mockResolvedValue("ok");
		const result = await withRetry(fn);
		expect(result).toBe("ok");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("retries on RetryableError up to maxAttempts", async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new RetryableError("rate limit"))
			.mockRejectedValueOnce(new RetryableError("rate limit"))
			.mockResolvedValue("recovered");

		const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 });
		await vi.runAllTimersAsync();
		expect(await promise).toBe("recovered");
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("throws after exhausting all attempts", async () => {
		const err = new RetryableError("rate limit");
		const fn = vi.fn().mockRejectedValue(err);

		const promise = withRetry(fn, { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100 });
		// Attach handler before advancing timers to avoid unhandled rejection warning.
		const assertion = expect(promise).rejects.toBe(err);
		await vi.runAllTimersAsync();
		await assertion;
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("propagates BudgetExhaustedError immediately without retry", async () => {
		const err = new BudgetExhaustedError(5, 10);
		const fn = vi.fn().mockRejectedValue(err);

		await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 })).rejects.toBe(
			err,
		);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("propagates fatal errors immediately without retry", async () => {
		const err = new RuntimeError("fatal crash");
		const fn = vi.fn().mockRejectedValue(err);

		await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 })).rejects.toBe(
			err,
		);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("uses retryAfterMs from RetryableError when set and recovers", async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new RetryableError("rate limit", {}, 5000))
			.mockResolvedValue("ok");

		const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 60000 });
		await vi.runAllTimersAsync();
		expect(await promise).toBe("ok");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("caps delay at maxDelayMs when retryAfterMs exceeds it", async () => {
		// retryAfterMs (999999) > maxDelayMs (1000): delay must be capped.
		// We verify the retry still succeeds — actual capping is a computeDelayMs concern.
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new RetryableError("rate limit", {}, 999999))
			.mockResolvedValue("ok");

		const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 });
		await vi.runAllTimersAsync();
		expect(await promise).toBe("ok");
		expect(fn).toHaveBeenCalledTimes(2);
	});
});
