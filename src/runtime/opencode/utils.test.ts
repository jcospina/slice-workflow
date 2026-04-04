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
import { runOpenCodeCli } from "./utils";

describe("runOpenCodeCli", () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	it("surfaces a focused prerequisite error when the OpenCode CLI is missing", async () => {
		const child = createFakeChildProcess();
		spawnMock.mockReturnValue(child);

		const execution = runOpenCodeCli({
			command: "opencode",
			args: ["--prompt", "Implement Slice 04"],
			cwd: "/tmp/slice",
			method: "runInteractive",
		});

		child.emit("error", Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" }));

		await expect(execution).rejects.toEqual(
			expect.objectContaining({
				name: "RuntimeError",
				message:
					"OpenCode CLI command 'opencode' was not found. Install OpenCode, ensure 'opencode' is available on PATH, and retry.",
				context: expect.objectContaining({
					command: "opencode",
					cwd: "/tmp/slice",
					method: "runInteractive",
					code: "ENOENT",
				}),
			}),
		);
	});

	it("surfaces a focused launch error when the OpenCode CLI is not executable", async () => {
		const child = createFakeChildProcess();
		spawnMock.mockReturnValue(child);

		const execution = runOpenCodeCli({
			command: "opencode",
			args: ["--prompt", "Implement Slice 04"],
			cwd: "/tmp/slice",
			method: "runInteractive",
		});

		child.emit("error", Object.assign(new Error("spawn opencode EACCES"), { code: "EACCES" }));

		await expect(execution).rejects.toEqual(
			expect.objectContaining({
				name: "RuntimeError",
				message:
					"OpenCode CLI command 'opencode' is not executable. Check the configured command path and permissions, then retry.",
				context: expect.objectContaining({
					command: "opencode",
					cwd: "/tmp/slice",
					method: "runInteractive",
					code: "EACCES",
				}),
			}),
		);
	});

	it("wraps synchronous launch failures in RuntimeError", async () => {
		spawnMock.mockImplementation(() => {
			throw new Error("spawn failed synchronously");
		});

		const execution = runOpenCodeCli({
			command: "opencode",
			args: ["--prompt", "Implement Slice 04"],
			cwd: "/tmp/slice",
			method: "runInteractive",
		});

		const error = await execution.catch((rejection) => rejection);

		expect(error).toBeInstanceOf(RuntimeError);
		expect(error).toMatchObject({
			message: "Failed to launch OpenCode CLI command 'opencode': spawn failed synchronously",
			context: expect.objectContaining({
				command: "opencode",
				cwd: "/tmp/slice",
				method: "runInteractive",
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
