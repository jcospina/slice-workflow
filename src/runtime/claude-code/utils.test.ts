import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

import { RuntimeError } from "../../utils/errors";
import { runClaudeCli } from "./utils";

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

function createFakeChildProcess(): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	child.stdout = new EventEmitter() as ChildProcess["stdout"];
	child.stderr = new EventEmitter() as ChildProcess["stderr"];
	return child;
}
