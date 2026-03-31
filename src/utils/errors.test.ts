import { describe, expect, it } from "vitest";
import {
	ConfigError,
	PhaseError,
	RuntimeError,
	SliceError,
	StateError,
	WorktreeError,
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
		const err = new PhaseError("review failed", { phase: "review", sliceIndex: 0 });
		expect(err).toBeInstanceOf(SliceError);
		expect(err.name).toBe("PhaseError");
		expect(err.context.phase).toBe("review");
		expect(err.context.sliceIndex).toBe(0);
	});
});
