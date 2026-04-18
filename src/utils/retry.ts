import { BudgetExhaustedError, RetryableError } from "./errors";

export interface RetryConfig {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

const DEFAULTS: RetryConfig = {
	maxAttempts: 3,
	baseDelayMs: 2000,
	maxDelayMs: 60000,
};

function computeDelayMs(attempt: number, config: RetryConfig, retryAfterMs: number | null): number {
	if (retryAfterMs !== null) {
		return Math.min(retryAfterMs, config.maxDelayMs);
	}
	const exponential = config.baseDelayMs * 2 ** (attempt - 1);
	const jitter = Math.random() * exponential * 0.2;
	return Math.min(exponential + jitter, config.maxDelayMs);
}

export async function withRetry<T>(
	fn: () => Promise<T>,
	config: Partial<RetryConfig> = {},
): Promise<T> {
	const resolved: RetryConfig = { ...DEFAULTS, ...config };
	let attempt = 0;

	for (;;) {
		attempt++;
		try {
			return await fn();
		} catch (error) {
			if (error instanceof BudgetExhaustedError) {
				throw error;
			}
			if (!(error instanceof RetryableError) || attempt >= resolved.maxAttempts) {
				throw error;
			}
			const delay = computeDelayMs(attempt, resolved, error.retryAfterMs);
			await new Promise<void>((resolve) => setTimeout(resolve, delay));
		}
	}
}
