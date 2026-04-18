import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

import { RetryableError, RuntimeError } from "../../utils/errors";
import { normalizeRunResult, runClaudeCli } from "./utils";

describe("runClaudeCli", () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	it("surfaces a focused prerequisite error when the Claude CLI is missing", async () => {
		const child = createFakeChildProcess();
		spawnMock.mockReturnValue(child);

		const execution = runClaudeCli({
			command: "claude",
			args: ["-p", "Implement Slice 04"],
			cwd: "/tmp/slice",
			method: "run",
		});

		child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));

		await expect(execution).rejects.toEqual(
			expect.objectContaining({
				name: "RuntimeError",
				message:
					"Claude CLI command 'claude' was not found. Install the Claude CLI, ensure 'claude' is available on PATH, and authenticate it before using the claude-code runtime.",
				context: expect.objectContaining({
					command: "claude",
					cwd: "/tmp/slice",
					method: "run",
					code: "ENOENT",
				}),
			}),
		);
	});

	it("surfaces a focused launch error when the Claude CLI is not executable", async () => {
		const child = createFakeChildProcess();
		spawnMock.mockReturnValue(child);

		const execution = runClaudeCli({
			command: "claude",
			args: ["Implement Slice 04"],
			cwd: "/tmp/slice",
			method: "runInteractive",
			stdio: "inherit",
		});

		child.emit("error", Object.assign(new Error("spawn claude EACCES"), { code: "EACCES" }));

		await expect(execution).rejects.toEqual(
			expect.objectContaining({
				name: "RuntimeError",
				message:
					"Claude CLI command 'claude' is not executable. Check the configured command path and permissions, then retry.",
				context: expect.objectContaining({
					command: "claude",
					cwd: "/tmp/slice",
					method: "runInteractive",
					code: "EACCES",
				}),
			}),
		);
	});

	it("wraps unexpected launch failures in RuntimeError", async () => {
		const child = createFakeChildProcess();
		spawnMock.mockReturnValue(child);

		const execution = runClaudeCli({
			command: "claude",
			args: ["-p", "Implement Slice 04"],
			cwd: "/tmp/slice",
			method: "run",
		});

		child.emit("error", new Error("socket hangup"));

		const error = await execution.catch((rejection) => rejection);

		expect(error).toBeInstanceOf(RuntimeError);
		expect(error).toMatchObject({
			message: "Failed to launch Claude CLI command 'claude': socket hangup",
			context: expect.objectContaining({
				command: "claude",
				cwd: "/tmp/slice",
				method: "run",
			}),
		});
	});
});

describe("normalizeRunResult", () => {
	it("returns success result when exit code is 0", () => {
		const result = normalizeRunResult(
			{ stdout: "done", stderr: "", exitCode: 0, signal: null },
			100,
			"session-1",
		);
		expect(result.success).toBe(true);
		expect(result.output).toBe("done");
	});

	it("returns failure result for non-zero exit with no rate-limit indicators", () => {
		const result = normalizeRunResult(
			{ stdout: "", stderr: "something went wrong", exitCode: 1, signal: null },
			100,
			"session-1",
		);
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	it("throws RetryableError when stderr contains 'rate limit'", () => {
		expect(() =>
			normalizeRunResult(
				{ stdout: "", stderr: "Error: rate limit exceeded", exitCode: 1, signal: null },
				100,
				"session-1",
			),
		).toThrow(RetryableError);
	});

	it("throws RetryableError when stderr contains '429'", () => {
		expect(() =>
			normalizeRunResult(
				{ stdout: "", stderr: "HTTP 429 Too Many Requests", exitCode: 1, signal: null },
				100,
				"session-1",
			),
		).toThrow(RetryableError);
	});

	it("throws RetryableError when stdout contains timeout indicator", () => {
		expect(() =>
			normalizeRunResult(
				{ stdout: "ETIMEDOUT connecting to api", stderr: "", exitCode: 1, signal: null },
				100,
				"session-1",
			),
		).toThrow(RetryableError);
	});

	it("parses retryAfterMs from Retry-After header in output", () => {
		let thrown: RetryableError | undefined;
		try {
			normalizeRunResult(
				{
					stdout: "",
					stderr: "rate limit hit. Retry-After: 30",
					exitCode: 1,
					signal: null,
				},
				100,
				"session-1",
			);
		} catch (err) {
			thrown = err as RetryableError;
		}
		expect(thrown).toBeInstanceOf(RetryableError);
		expect(thrown?.retryAfterMs).toBe(30000);
	});

	it("sets retryAfterMs to null when no Retry-After header", () => {
		let thrown: RetryableError | undefined;
		try {
			normalizeRunResult(
				{ stdout: "", stderr: "429 too many requests", exitCode: 1, signal: null },
				100,
				"session-1",
			);
		} catch (err) {
			thrown = err as RetryableError;
		}
		expect(thrown).toBeInstanceOf(RetryableError);
		expect(thrown?.retryAfterMs).toBeNull();
	});
});

function createFakeChildProcess(): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	child.stdout = new EventEmitter() as ChildProcess["stdout"];
	child.stderr = new EventEmitter() as ChildProcess["stderr"];
	return child;
}
