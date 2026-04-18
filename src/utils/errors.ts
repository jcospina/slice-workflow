export interface ErrorContext {
	phase?: string;
	sliceIndex?: number;
	path?: string;
	[key: string]: unknown;
}

export class SliceError extends Error {
	readonly context: ErrorContext;

	constructor(message: string, context: ErrorContext = {}) {
		super(message);
		this.name = "SliceError";
		this.context = context;
	}
}

export class ConfigError extends SliceError {
	constructor(message: string, context: ErrorContext = {}) {
		super(message, context);
		this.name = "ConfigError";
	}
}

export class RuntimeError extends SliceError {
	constructor(message: string, context: ErrorContext = {}) {
		super(message, context);
		this.name = "RuntimeError";
	}
}

export class StateError extends SliceError {
	constructor(message: string, context: ErrorContext = {}) {
		super(message, context);
		this.name = "StateError";
	}
}

export class WorktreeError extends SliceError {
	constructor(message: string, context: ErrorContext = {}) {
		super(message, context);
		this.name = "WorktreeError";
	}
}

export class PhaseError extends SliceError {
	constructor(message: string, context: ErrorContext = {}) {
		super(message, context);
		this.name = "PhaseError";
	}
}

export class RetryableError extends SliceError {
	readonly retryAfterMs: number | null;

	constructor(message: string, context: ErrorContext = {}, retryAfterMs: number | null = null) {
		super(message, context);
		this.name = "RetryableError";
		this.retryAfterMs = retryAfterMs;
	}
}

export class BudgetExhaustedError extends SliceError {
	readonly spentUsd: number;
	readonly limitUsd: number;

	constructor(spentUsd: number, limitUsd: number, context: ErrorContext = {}) {
		super(
			`Budget exhausted: spent $${spentUsd.toFixed(4)} of $${limitUsd.toFixed(4)} limit.`,
			context,
		);
		this.name = "BudgetExhaustedError";
		this.spentUsd = spentUsd;
		this.limitUsd = limitUsd;
	}
}

export function categorizeError(error: unknown): "retryable" | "fatal" | "budget" {
	if (error instanceof BudgetExhaustedError) {
		return "budget";
	}
	if (error instanceof RetryableError) {
		return "retryable";
	}
	if (error instanceof RuntimeError) {
		const msg = error.message.toLowerCase();
		if (msg.includes("rate limit") || msg.includes("429") || msg.includes("timeout")) {
			return "retryable";
		}
	}
	return "fatal";
}
