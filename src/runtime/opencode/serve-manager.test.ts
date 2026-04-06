import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { LocalOpenCodeServeManager } from "./serve-manager";

describe("LocalOpenCodeServeManager", () => {
	it("does not spawn opencode serve when the server probe is already healthy", async () => {
		const probeServer = vi.fn().mockResolvedValue(undefined);
		const spawnProcess = vi.fn();
		const manager = new LocalOpenCodeServeManager(
			{},
			{
				probeServer,
				spawnProcess: spawnProcess as unknown as typeof spawn,
			},
		);

		await manager.ensureServer({ cwd: "/tmp/slice" });

		expect(probeServer).toHaveBeenCalledWith({ cwd: "/tmp/slice" });
		expect(spawnProcess).not.toHaveBeenCalled();
	});

	it("spawns opencode serve and waits until probe succeeds", async () => {
		const child = createFakeChildProcess();
		const probeServer = vi
			.fn()
			.mockRejectedValueOnce(new Error("server not ready"))
			.mockResolvedValue(undefined);
		const spawnProcess = vi.fn().mockReturnValue(child);
		const manager = new LocalOpenCodeServeManager(
			{ command: "opencode-work", startupPollIntervalMs: 1 },
			{
				probeServer,
				spawnProcess: spawnProcess as unknown as typeof spawn,
				wait: vi.fn().mockResolvedValue(undefined),
			},
		);

		await manager.ensureServer({ cwd: "/tmp/slice" });

		expect(spawnProcess).toHaveBeenCalledTimes(1);
		expect(spawnProcess).toHaveBeenCalledWith("opencode-work", ["serve"], {
			cwd: "/tmp/slice",
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(probeServer).toHaveBeenCalledTimes(2);
	});

	it("surfaces focused ENOENT launch errors when opencode CLI is missing", async () => {
		const child = createFakeChildProcess();
		const probeServer = vi.fn().mockRejectedValue(new Error("server not ready"));
		const spawnProcess = vi.fn().mockImplementation(() => {
			queueMicrotask(() => {
				child.emit("error", Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" }));
			});
			return child;
		});
		const manager = new LocalOpenCodeServeManager(
			{ startupPollIntervalMs: 1, startupTimeoutMs: 100 },
			{
				probeServer,
				spawnProcess: spawnProcess as unknown as typeof spawn,
				wait: vi.fn().mockResolvedValue(undefined),
			},
		);

		await expect(manager.ensureServer({ cwd: "/tmp/slice" })).rejects.toEqual(
			expect.objectContaining({
				name: "RuntimeError",
				message:
					"OpenCode CLI command 'opencode' was not found. Install OpenCode, ensure 'opencode' is available on PATH, and retry.",
				context: expect.objectContaining({
					command: "opencode",
					cwd: "/tmp/slice",
					method: "run",
					code: "ENOENT",
				}),
			}),
		);
	});

	it("surfaces focused launch errors when the opencode command is not executable", async () => {
		const probeServer = vi.fn().mockRejectedValue(new Error("server not ready"));
		const spawnProcess = vi.fn().mockImplementation(() => {
			throw Object.assign(new Error("spawn opencode EACCES"), { code: "EACCES" });
		});
		const manager = new LocalOpenCodeServeManager(
			{ startupPollIntervalMs: 1, startupTimeoutMs: 100 },
			{
				probeServer,
				spawnProcess: spawnProcess as unknown as typeof spawn,
			},
		);

		await expect(manager.ensureServer({ cwd: "/tmp/slice" })).rejects.toEqual(
			expect.objectContaining({
				name: "RuntimeError",
				message:
					"OpenCode CLI command 'opencode' is not executable. Check the configured command path and permissions, then retry.",
				context: expect.objectContaining({
					command: "opencode",
					cwd: "/tmp/slice",
					method: "run",
					code: "EACCES",
				}),
			}),
		);
	});

	it("fails fast when the managed opencode server exits before readiness", async () => {
		const child = createFakeChildProcess();
		const probeServer = vi.fn().mockRejectedValue(new Error("still booting"));
		const spawnProcess = vi.fn().mockReturnValue(child);
		const wait = vi.fn().mockImplementation(() => {
			(child as unknown as { exitCode: number | null }).exitCode = 1;
			child.emit("close", 1, null);
			return Promise.resolve();
		});
		const manager = new LocalOpenCodeServeManager(
			{ startupTimeoutMs: 100, startupPollIntervalMs: 1 },
			{
				probeServer,
				spawnProcess: spawnProcess as unknown as typeof spawn,
				wait,
			},
		);

		await expect(manager.ensureServer({ cwd: "/tmp/slice" })).rejects.toThrow(
			"OpenCode server process exited before becoming ready.",
		);
	});

	it("fails with a timeout when the local server never becomes ready", async () => {
		const child = createFakeChildProcess();
		const probeServer = vi.fn().mockRejectedValue(new Error("still booting"));
		const spawnProcess = vi.fn().mockReturnValue(child);
		let nowTick = 0;
		const manager = new LocalOpenCodeServeManager(
			{ startupTimeoutMs: 40, startupPollIntervalMs: 1 },
			{
				probeServer,
				spawnProcess: spawnProcess as unknown as typeof spawn,
				wait: vi.fn().mockResolvedValue(undefined),
				now: () => {
					nowTick += 10;
					return nowTick;
				},
			},
		);

		await expect(manager.ensureServer({ cwd: "/tmp/slice" })).rejects.toThrow(
			"Timed out waiting for OpenCode server readiness",
		);
	});

	it("terminates a managed server process on stopServer()", async () => {
		const child = createFakeChildProcess({ closeOnSignals: ["SIGTERM"] });
		const probeServer = vi
			.fn()
			.mockRejectedValueOnce(new Error("server not ready"))
			.mockResolvedValue(undefined);
		const spawnProcess = vi.fn().mockReturnValue(child);
		const manager = new LocalOpenCodeServeManager(
			{ startupPollIntervalMs: 1 },
			{
				probeServer,
				spawnProcess: spawnProcess as unknown as typeof spawn,
				wait: vi.fn().mockResolvedValue(undefined),
			},
		);

		await manager.ensureServer({ cwd: "/tmp/slice" });
		await manager.stopServer();

		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	});
});

function createFakeChildProcess(
	options: {
		closeOnSignals?: NodeJS.Signals[];
	} = {},
): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
	const child = new EventEmitter() as ChildProcess & { kill: ReturnType<typeof vi.fn> };

	child.stdout = new EventEmitter() as ChildProcess["stdout"];
	child.stderr = new EventEmitter() as ChildProcess["stderr"];
	Object.defineProperty(child, "exitCode", { value: null, writable: true, configurable: true });
	Object.defineProperty(child, "signalCode", { value: null, writable: true, configurable: true });
	child.kill = vi.fn().mockImplementation((signal?: NodeJS.Signals) => {
		if (signal && options.closeOnSignals?.includes(signal)) {
			(child as unknown as { exitCode: number | null }).exitCode = 0;
			(child as unknown as { signalCode: NodeJS.Signals | null }).signalCode = null;
			child.emit("close", 0, null);
		}

		return true;
	});

	return child;
}
