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
