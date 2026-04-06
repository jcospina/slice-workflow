import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RuntimeError } from "../../utils/errors";
import { OpenCodeRuntime } from "./index";
import type { OpenCodeServeManager } from "./serve-manager";

describe("OpenCodeRuntime", () => {
	it("locks the provider identifier to opencode", () => {
		const runtime = new OpenCodeRuntime();

		expect(runtime.provider).toBe("opencode");
	});

	it("retains the resolved provider config for later slices", () => {
		const runtime = new OpenCodeRuntime({ model: "ollama/qwen2.5-coder:32b" });

		expect(runtime.config).toEqual({ model: "ollama/qwen2.5-coder:32b" });
	});

	it("accepts an injected serve-manager seam for future lifecycle behavior", () => {
		const serveManager: OpenCodeServeManager = {
			ensureServer: vi.fn(),
			stopServer: vi.fn(),
		};
		const runtime = new OpenCodeRuntime({}, { serveManager });

		expect(runtime.serveManager).toBe(serveManager);
	});

	it("runs SDK session create/prompt from cwd, ensures local serve, and auto-replies permissions", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "opencode-runtime-"));
		const contextFile = "context.md";
		const contextPath = join(cwd, contextFile);
		const ensureServer = vi.fn().mockResolvedValue(undefined);
		const create = vi.fn().mockResolvedValue({ data: { id: "sess-opencode-1" } });
		const prompt = vi.fn().mockResolvedValue({
			data: {
				info: { sessionId: "sess-opencode-1", cost: 1.75 },
				parts: [{ type: "text", text: "Implemented Slice 02" }],
			},
		});
		const replyPermission = vi.fn().mockResolvedValue({ data: true });
		const subscribe = vi.fn().mockReturnValue({
			stream: createEventStream([
				{
					type: "permission.updated",
					properties: { sessionId: "sess-other", id: "perm-ignore" },
				},
				{
					type: "permission.updated",
					properties: { sessionId: "sess-opencode-1", id: "perm-accept" },
				},
			]),
		});
		const runtime = new OpenCodeRuntime(
			{ model: "ollama/qwen2.5-coder:32b" },
			{
				serveManager: { ensureServer, stopServer: vi.fn() },
				now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(475),
				createSessionId: () => "sess-fallback",
				createClient: () => ({
					session: { create, prompt },
					event: { subscribe },
					postSessionIdPermissionsPermissionId: replyPermission,
				}),
			},
		);

		try {
			await writeFile(contextPath, "# Context\nKeep OpenCode scoped to Slice 02.");

			const result = await runtime.run({
				prompt: "Implement Slice 02 only.\nNo Slice 03 work.",
				systemPrompt: "Stay inside current slice boundaries.",
				contextFiles: [contextFile],
				allowedTools: ["read", "write", "  "],
				cwd,
			});

			expect(ensureServer).toHaveBeenCalledWith({ cwd });
			expect(create).toHaveBeenCalledWith({
				query: { directory: cwd },
				body: { title: "Implement Slice 02 only." },
			});
			expect(prompt).toHaveBeenCalledWith({
				path: { id: "sess-opencode-1" },
				query: { directory: cwd },
				body: {
					parts: [
						{
							type: "text",
							text: [
								`Context file: ${contextPath}\n# Context\nKeep OpenCode scoped to Slice 02.`,
								"Task:\nImplement Slice 02 only.\nNo Slice 03 work.",
							].join("\n\n"),
						},
					],
					system: "Stay inside current slice boundaries.",
					model: { providerId: "ollama", modelId: "qwen2.5-coder:32b" },
					tools: { read: true, write: true },
				},
			});
			expect(replyPermission).toHaveBeenCalledTimes(1);
			expect(replyPermission).toHaveBeenCalledWith({
				path: { id: "sess-opencode-1", permissionId: "perm-accept" },
				query: { directory: cwd },
				body: { response: "once" },
			});
			expect(ensureServer.mock.invocationCallOrder[0]).toBeLessThan(
				create.mock.invocationCallOrder[0],
			);
			expect(result).toEqual({
				success: true,
				output: "Implemented Slice 02",
				sessionId: "sess-opencode-1",
				costUsd: 1.75,
				durationMs: 375,
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("defaults costUsd to 0 when usage metadata is unavailable", async () => {
		const runtime = new OpenCodeRuntime(
			{},
			{
				serveManager: { ensureServer: vi.fn(), stopServer: vi.fn() },
				now: vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(6),
				createSessionId: () => "sess-fallback",
				createClient: () => ({
					session: {
						create: vi.fn().mockResolvedValue({ data: { id: "sess-opencode-2" } }),
						prompt: vi.fn().mockResolvedValue({
							data: {
								info: { sessionId: "sess-opencode-2" },
								parts: [{ type: "text", text: "Done without usage metadata." }],
							},
						}),
					},
					event: { subscribe: vi.fn().mockReturnValue({ stream: createEventStream([]) }) },
					postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({ data: true }),
				}),
			},
		);

		const result = await runtime.run({ prompt: "Implement Slice 02", cwd: "/tmp/slice" });

		expect(result.costUsd).toBe(0);
		expect(result).toEqual({
			success: true,
			output: "Done without usage metadata.",
			sessionId: "sess-opencode-2",
			costUsd: 0,
			durationMs: 5,
		});
	});

	it("normalizes assistant-reported session errors into a failed AgentRunResult", async () => {
		const runtime = new OpenCodeRuntime(
			{},
			{
				serveManager: { ensureServer: vi.fn(), stopServer: vi.fn() },
				now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(45),
				createSessionId: () => "sess-fallback",
				createClient: () => ({
					session: {
						create: vi.fn().mockResolvedValue({ data: { id: "sess-opencode-3" } }),
						prompt: vi.fn().mockResolvedValue({
							data: {
								info: {
									sessionId: "sess-opencode-3",
									error: {
										name: "ProviderAuthError",
										data: { message: "OpenCode provider auth is required." },
									},
								},
								parts: [{ type: "text", text: "Partial output before failure." }],
							},
						}),
					},
					event: { subscribe: vi.fn().mockReturnValue({ stream: createEventStream([]) }) },
					postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({ data: true }),
				}),
			},
		);

		const result = await runtime.run({ prompt: "Implement Slice 02", cwd: "/tmp/slice" });

		expect(result).toEqual({
			success: false,
			output: "Partial output before failure.",
			sessionId: "sess-opencode-3",
			costUsd: 0,
			durationMs: 35,
			error: "OpenCode provider auth is required.",
		});
	});

	it("normalizes SDK call failures into a failed AgentRunResult with stable session fallback", async () => {
		const onProgress = vi.fn();
		const runtime = new OpenCodeRuntime(
			{},
			{
				serveManager: { ensureServer: vi.fn(), stopServer: vi.fn() },
				now: vi.fn().mockReturnValueOnce(50).mockReturnValueOnce(75),
				createSessionId: () => "sess-fallback-4",
				createClient: () => ({
					session: {
						create: vi.fn().mockResolvedValue({
							error: { data: { message: "OpenCode server unavailable." } },
						}),
						prompt: vi.fn(),
					},
					event: { subscribe: vi.fn().mockReturnValue({ stream: createEventStream([]) }) },
					postSessionIdPermissionsPermissionId: vi.fn(),
				}),
			},
		);

		const result = await runtime.run({
			prompt: "Implement Slice 02",
			cwd: "/tmp/slice",
			onProgress,
		});

		expect(result).toEqual({
			success: false,
			output: "Failed to create OpenCode session. OpenCode server unavailable.",
			sessionId: "sess-fallback-4",
			costUsd: 0,
			durationMs: 25,
			error: "Failed to create OpenCode session. OpenCode server unavailable.",
		});
		expect(onProgress).toHaveBeenNthCalledWith(1, { type: "agent_start" });
		expect(onProgress).toHaveBeenNthCalledWith(2, {
			type: "error",
			message: "Failed to create OpenCode session. OpenCode server unavailable.",
		});
	});

	it("normalizes managed server launch failures into a failed AgentRunResult", async () => {
		const onProgress = vi.fn();
		const createClient = vi.fn();
		const runtime = new OpenCodeRuntime(
			{},
			{
				serveManager: {
					ensureServer: vi.fn().mockRejectedValue(
						new RuntimeError(
							"OpenCode CLI command 'opencode' was not found. Install OpenCode, ensure 'opencode' is available on PATH, and retry.",
							{
								command: "opencode",
								code: "ENOENT",
							},
						),
					),
					stopServer: vi.fn(),
				},
				createClient,
				now: vi.fn().mockReturnValueOnce(200).mockReturnValueOnce(245),
				createSessionId: () => "sess-fallback-serve-failure",
			},
		);

		const result = await runtime.run({
			prompt: "Implement Slice 04",
			cwd: "/tmp/slice",
			onProgress,
		});

		expect(createClient).not.toHaveBeenCalled();
		expect(result).toEqual({
			success: false,
			output:
				"OpenCode CLI command 'opencode' was not found. Install OpenCode, ensure 'opencode' is available on PATH, and retry.",
			sessionId: "sess-fallback-serve-failure",
			costUsd: 0,
			durationMs: 45,
			error:
				"OpenCode CLI command 'opencode' was not found. Install OpenCode, ensure 'opencode' is available on PATH, and retry.",
		});
		expect(onProgress).toHaveBeenNthCalledWith(1, { type: "agent_start" });
		expect(onProgress).toHaveBeenNthCalledWith(2, {
			type: "error",
			message:
				"OpenCode CLI command 'opencode' was not found. Install OpenCode, ensure 'opencode' is available on PATH, and retry.",
		});
	});

	it("launches an interactive OpenCode session with inherited stdio in the target cwd", async () => {
		const runOpenCodeCli = vi.fn().mockResolvedValue({
			stdout: "",
			stderr: "",
			exitCode: 0,
			signal: null,
		});
		const runtime = new OpenCodeRuntime(
			{ command: "opencode-work" },
			{
				runOpenCodeCli,
				now: vi.fn().mockReturnValueOnce(20).mockReturnValueOnce(90),
				createSessionId: () => "sess-interactive-1",
			},
		);

		const result = await runtime.runInteractive({
			cwd: "/tmp/slice",
			prompt: "Smoke interactive handoff",
		});

		expect(runOpenCodeCli).toHaveBeenCalledTimes(1);
		expect(runOpenCodeCli).toHaveBeenCalledWith({
			command: "opencode-work",
			args: ["--prompt", "Task:\nSmoke interactive handoff"],
			cwd: "/tmp/slice",
			method: "runInteractive",
			stdio: "inherit",
		});
		expect(result).toEqual({
			success: true,
			output: "",
			sessionId: "sess-interactive-1",
			costUsd: 0,
			durationMs: 70,
		});
	});

	it("normalizes interactive termination into a failed AgentRunResult", async () => {
		const runtime = new OpenCodeRuntime(
			{},
			{
				runOpenCodeCli: vi.fn().mockResolvedValue({
					stdout: "",
					stderr: "",
					exitCode: null,
					signal: "SIGTERM",
				}),
				now: vi.fn().mockReturnValueOnce(300).mockReturnValueOnce(360),
				createSessionId: () => "sess-interactive-2",
			},
		);

		const result = await runtime.runInteractive({ cwd: "/tmp/slice" });

		expect(result).toEqual({
			success: false,
			output: "OpenCode CLI terminated with signal SIGTERM.",
			sessionId: "sess-interactive-2",
			costUsd: 0,
			durationMs: 60,
			error: "OpenCode CLI terminated with signal SIGTERM.",
		});
	});

	it("injects RFC artifact writing instruction into the system prompt when rfcArtifactPath is provided", async () => {
		const runOpenCodeCli = vi.fn().mockResolvedValue({
			stdout: "",
			stderr: "",
			exitCode: 0,
			signal: null,
		});
		const runtime = new OpenCodeRuntime(
			{},
			{
				runOpenCodeCli,
				now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(50),
				createSessionId: () => "sess-rfc-1",
			},
		);

		await runtime.runInteractive({
			cwd: "/tmp/slice",
			prompt: "Draft the RFC.",
			rfcArtifactPath: "/tmp/implementations/my-feature-rfc-draft.md",
		});

		expect(runOpenCodeCli).toHaveBeenCalledWith({
			command: "opencode",
			args: [
				"--prompt",
				[
					"System instructions:\nWhen you are done, write the complete RFC draft as a Markdown document to:\n/tmp/implementations/my-feature-rfc-draft.md",
					"Task:\nDraft the RFC.",
				].join("\n\n"),
			],
			cwd: "/tmp/slice",
			method: "runInteractive",
			stdio: "inherit",
		});
	});

	it("merges rfcArtifactPath instruction with an existing system prompt", async () => {
		const runOpenCodeCli = vi.fn().mockResolvedValue({
			stdout: "",
			stderr: "",
			exitCode: 0,
			signal: null,
		});
		const runtime = new OpenCodeRuntime(
			{},
			{
				runOpenCodeCli,
				now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(50),
				createSessionId: () => "sess-rfc-2",
			},
		);

		await runtime.runInteractive({
			cwd: "/tmp/slice",
			prompt: "Draft the RFC.",
			systemPrompt: "Stay focused on the task.",
			rfcArtifactPath: "/tmp/implementations/my-feature-rfc-draft.md",
		});

		expect(runOpenCodeCli).toHaveBeenCalledWith({
			command: "opencode",
			args: [
				"--prompt",
				[
					"System instructions:\nStay focused on the task.\n\nWhen you are done, write the complete RFC draft as a Markdown document to:\n/tmp/implementations/my-feature-rfc-draft.md",
					"Task:\nDraft the RFC.",
				].join("\n\n"),
			],
			cwd: "/tmp/slice",
			method: "runInteractive",
			stdio: "inherit",
		});
	});
});

function createEventStream(
	events: Array<{ type?: string; properties?: { sessionId?: string; id?: string } }>,
): AsyncIterable<{
	type?: string;
	properties?: { sessionId?: string; id?: string };
}> {
	return {
		async *[Symbol.asyncIterator]() {
			await Promise.resolve();
			for (const event of events) {
				yield event;
			}
		},
	};
}
