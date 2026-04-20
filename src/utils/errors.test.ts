import { describe, expect, it } from "vitest";
import {
	BudgetExhaustedError,
	ConfigError,
	PhaseError,
	RetryableError,
	RuntimeError,
	SliceError,
	StateError,
	WorktreeError,
	categorizeError,
} from "./errors";

describe("SliceError", () => {
	it("sets message and name", () => {
		const err = new SliceError("something broke");
		expect(err.message).toBe("something broke");
		expect(err.name).toBe("SliceError");
	});

	it("defaults context to empty object", () => {
		const err = new SliceError("oops");
		expect(err.context).toEqual({});
	});

	it("stores structured context", () => {
		const err = new SliceError("fail", { phase: "execute", sliceIndex: 2 });
		expect(err.context.phase).toBe("execute");
		expect(err.context.sliceIndex).toBe(2);
	});

	it("is an instance of Error", () => {
		const err = new SliceError("test");
		expect(err).toBeInstanceOf(Error);
	});
});

describe("ConfigError", () => {
	it("extends SliceError", () => {
		const err = new ConfigError("bad config", { path: "/foo/bar" });
		expect(err).toBeInstanceOf(SliceError);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("ConfigError");
		expect(err.context.path).toBe("/foo/bar");
	});
});

describe("RuntimeError", () => {
	it("extends SliceError", () => {
		const err = new RuntimeError("crashed");
		expect(err).toBeInstanceOf(SliceError);
		expect(err.name).toBe("RuntimeError");
	});
});

describe("StateError", () => {
	it("extends SliceError with context", () => {
		const err = new StateError("db gone", { phase: "plan" });
		expect(err).toBeInstanceOf(SliceError);
		expect(err.name).toBe("StateError");
		expect(err.context.phase).toBe("plan");
	});
});

describe("WorktreeError", () => {
	it("extends SliceError", () => {
		const err = new WorktreeError("branch conflict", { path: "/tmp/wt" });
		expect(err).toBeInstanceOf(SliceError);
		expect(err.name).toBe("WorktreeError");
		expect(err.context.path).toBe("/tmp/wt");
	});
});

describe("PhaseError", () => {
	it("extends SliceError with phase context", () => {
		const err = new PhaseError("execute failed", { phase: "execute", sliceIndex: 0 });
		expect(err).toBeInstanceOf(SliceError);
		expect(err.name).toBe("PhaseError");
		expect(err.context.phase).toBe("execute");
		expect(err.context.sliceIndex).toBe(0);
	});
});

describe("RetryableError", () => {
	it("extends SliceError", () => {
		const err = new RetryableError("rate limited");
		expect(err).toBeInstanceOf(SliceError);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("RetryableError");
	});

	it("defaults retryAfterMs to null", () => {
		const err = new RetryableError("rate limited");
		expect(err.retryAfterMs).toBeNull();
	});

	it("stores retryAfterMs when provided", () => {
		const err = new RetryableError("rate limited", {}, 30000);
		expect(err.retryAfterMs).toBe(30000);
	});
});

describe("BudgetExhaustedError", () => {
	it("extends SliceError", () => {
		const err = new BudgetExhaustedError(1.5, 2.0);
		expect(err).toBeInstanceOf(SliceError);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("BudgetExhaustedError");
	});

	it("stores spentUsd and limitUsd", () => {
		const err = new BudgetExhaustedError(1.5, 2.0);
		expect(err.spentUsd).toBe(1.5);
		expect(err.limitUsd).toBe(2.0);
	});

	it("builds a descriptive message", () => {
		const err = new BudgetExhaustedError(1.5, 2.0);
		expect(err.message).toContain("Budget exhausted");
		expect(err.message).toContain("1.5000");
		expect(err.message).toContain("2.0000");
	});
});

describe("categorizeError", () => {
	it("returns 'budget' for BudgetExhaustedError", () => {
		expect(categorizeError(new BudgetExhaustedError(1, 2))).toBe("budget");
	});

	it("returns 'retryable' for RetryableError", () => {
		expect(categorizeError(new RetryableError("rate limited"))).toBe("retryable");
	});

	it("returns 'retryable' for RuntimeError with 'rate limit' message", () => {
		expect(categorizeError(new RuntimeError("rate limit exceeded"))).toBe("retryable");
	});

	it("returns 'retryable' for RuntimeError with '429' message", () => {
		expect(categorizeError(new RuntimeError("HTTP 429 error"))).toBe("retryable");
	});

	it("returns 'retryable' for RuntimeError with 'timeout' message", () => {
		expect(categorizeError(new RuntimeError("request timeout"))).toBe("retryable");
	});

	it("returns 'fatal' for ConfigError", () => {
		expect(categorizeError(new ConfigError("bad config"))).toBe("fatal");
	});

	it("returns 'fatal' for unknown errors", () => {
		expect(categorizeError(new Error("unknown"))).toBe("fatal");
		expect(categorizeError("a string")).toBe("fatal");
		expect(categorizeError(null)).toBe("fatal");
	});
});
