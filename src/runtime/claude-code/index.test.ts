import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RuntimeError } from "../../utils/errors";
import { ClaudeCodeRuntime } from "./index";

describe("ClaudeCodeRuntime", () => {
	it("locks the provider identifier to claude-code", () => {
		const runtime = new ClaudeCodeRuntime();

		expect(runtime.provider).toBe("claude-code");
	});

	it("retains the resolved provider config for later slices", () => {
		const runtime = new ClaudeCodeRuntime({ model: "sonnet" });

		expect(runtime.config).toEqual({ model: "sonnet" });
	});

	it("invokes claude in print mode from the target cwd and maps runtime controls", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "claude-code-runtime-"));
		const contextFile = "context.md";
		const contextPath = join(cwd, contextFile);
		const runClaudeCli = vi.fn().mockResolvedValue({
			stdout: "Implemented Slice 02",
			stderr: "",
			exitCode: 0,
			signal: null,
		});
		const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(325);
		const runtime = new ClaudeCodeRuntime(
			{ model: "sonnet" },
			{
				runClaudeCli,
				now,
				createSessionId: () => "sess-local-fallback",
			},
		);

		try {
			await writeFile(contextPath, "# Context\nKeep the provider id locked.");

			const result = await runtime.run({
				prompt: "Implement Slice 02 only.",
				systemPrompt: "Stay inside the current slice.",
				contextFiles: [contextFile],
				maxTurns: 7,
				allowedTools: ["Bash(npm test)", "Read", "  "],
				cwd,
			});

			expect(runClaudeCli).toHaveBeenCalledTimes(1);
			expect(runClaudeCli).toHaveBeenCalledWith({
				command: "claude",
				args: [
					"--model",
					"sonnet",
					"--max-turns",
					"7",
					"--allowedTools",
					"Bash(npm test),Read",
					"-p",
					[
						"System instructions:\nStay inside the current slice.",
						`Context file: ${contextPath}\n# Context\nKeep the provider id locked.`,
						"Task:\nImplement Slice 02 only.",
					].join("\n\n"),
				],
				cwd,
				method: "run",
				onStdout: expect.any(Function),
			});
			expect(result).toEqual({
				success: true,
				output: "Implemented Slice 02",
				sessionId: "sess-local-fallback",
				costUsd: 0,
				durationMs: 225,
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("honors a configured Claude command alias when provided", async () => {
		const runClaudeCli = vi.fn().mockResolvedValue({
			stdout: "Implemented Slice 02",
			stderr: "",
			exitCode: 0,
			signal: null,
		});
		const runtime = new ClaudeCodeRuntime(
			{ command: "klaude" },
			{
				runClaudeCli,
				now: vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(2),
				createSessionId: () => "sess-klaude",
			},
		);

		await runtime.run({ prompt: "Implement Slice 02 only.", cwd: "/tmp/slice" });

		expect(runClaudeCli).toHaveBeenCalledWith({
			command: "klaude",
			args: ["-p", "Task:\nImplement Slice 02 only."],
			cwd: "/tmp/slice",
			method: "run",
			onStdout: expect.any(Function),
		});
	});

	it("maps maxTurns and approval-free allowedTools onto Claude CLI args", async () => {
		const runClaudeCli = vi.fn().mockResolvedValue({
			stdout: "Implemented Slice 08",
			stderr: "",
			exitCode: 0,
			signal: null,
		});
		const runtime = new ClaudeCodeRuntime(
			{ model: "sonnet" },
			{
				runClaudeCli,
				now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(20),
				createSessionId: () => "sess-turns-tools",
			},
		);

		await runtime.run({
			prompt: "Implement Slice 08 only.",
			cwd: "/tmp/slice",
			maxTurns: 3,
			allowedTools: ["Edit", " Write ", "", "Bash(git status:*)"],
		});

		expect(runClaudeCli).toHaveBeenCalledWith({
			command: "claude",
			args: [
				"--model",
				"sonnet",
				"--max-turns",
				"3",
				"--allowedTools",
				"Edit,Write,Bash(git status:*)",
				"-p",
				"Task:\nImplement Slice 08 only.",
			],
			cwd: "/tmp/slice",
			method: "run",
			onStdout: expect.any(Function),
		});
	});

	it("normalizes non-zero exit results into a failed AgentRunResult", async () => {
		const runtime = new ClaudeCodeRuntime(
			{},
			{
				runClaudeCli: vi.fn().mockResolvedValue({
					stdout: "Partial output",
					stderr: "Claude reported a failure",
					exitCode: 2,
					signal: null,
				}),
				now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(60),
				createSessionId: () => "sess-failed",
			},
		);

		const result = await runtime.run({ prompt: "Implement Slice 02", cwd: "/tmp/slice" });

		expect(result).toEqual({
			success: false,
			output: "Partial output\n\nClaude reported a failure",
			sessionId: "sess-failed",
			costUsd: 0,
			durationMs: 50,
			error: "Claude reported a failure",
		});
	});

	it("reports Claude CLI launch failures through progress before rethrowing", async () => {
		const onProgress = vi.fn();
		const runtime = new ClaudeCodeRuntime(
			{},
			{
				runClaudeCli: vi.fn().mockRejectedValue(
					new RuntimeError("Claude CLI command 'claude' was not found.", {
						command: "claude",
						code: "ENOENT",
					}),
				),
			},
		);

		await expect(
			runtime.run({
				prompt: "Implement Slice 04",
				cwd: "/tmp/slice",
				onProgress,
			}),
		).rejects.toThrow("Claude CLI command 'claude' was not found.");

		expect(onProgress).toHaveBeenNthCalledWith(1, { type: "agent_start" });
		expect(onProgress).toHaveBeenNthCalledWith(2, {
			type: "error",
			message: "Claude CLI command 'claude' was not found.",
		});
	});

	it("keeps costUsd at 0 when the CLI does not expose usage data", async () => {
		const runtime = new ClaudeCodeRuntime(
			{},
			{
				runClaudeCli: vi.fn().mockResolvedValue({
					stdout: "Completed without usage metadata",
					stderr: "",
					exitCode: 0,
					signal: null,
				}),
				now: vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(2),
				createSessionId: () => "sess-no-cost",
			},
		);

		const result = await runtime.run({ prompt: "Implement Slice 02", cwd: "/tmp/slice" });

		expect(result.costUsd).toBe(0);
		expect(result.costUsd).not.toBeNull();
	});

	it("launches an interactive Claude session with inherited stdio in the target cwd", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "claude-code-interactive-"));
		const contextFile = "context.md";
		const contextPath = join(cwd, contextFile);
		const sessionId = "123e4567-e89b-12d3-a456-426614174000";
		const runClaudeCli = vi.fn().mockResolvedValue({
			stdout: "",
			stderr: "",
			exitCode: 0,
			signal: null,
		});
		const runtime = new ClaudeCodeRuntime(
			{ command: "klaude", model: "sonnet" },
			{
				runClaudeCli,
				now: vi.fn().mockReturnValueOnce(500).mockReturnValueOnce(950),
				createSessionId: () => sessionId,
			},
		);

		try {
			await writeFile(contextPath, "# Context\nKeep the terminal attached.");

			const result = await runtime.runInteractive({
				cwd,
				prompt: "Implement Slice 03 only.",
				systemPrompt: "Stay inside the current slice.",
				contextFiles: [contextFile],
			});

			expect(runClaudeCli).toHaveBeenCalledTimes(1);
			expect(runClaudeCli).toHaveBeenCalledWith({
				command: "klaude",
				args: [
					"--model",
					"sonnet",
					"--session-id",
					sessionId,
					"--append-system-prompt",
					"Stay inside the current slice.",
					[
						`Context file: ${contextPath}\n# Context\nKeep the terminal attached.`,
						"Task:\nImplement Slice 03 only.",
					].join("\n\n"),
				],
				cwd,
				method: "runInteractive",
				stdio: "inherit",
			});
			expect(result).toEqual({
				success: true,
				output: "",
				sessionId,
				costUsd: 0,
				durationMs: 450,
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("normalizes interactive termination into a failed AgentRunResult", async () => {
		const sessionId = "123e4567-e89b-12d3-a456-426614174001";
		const runtime = new ClaudeCodeRuntime(
			{},
			{
				runClaudeCli: vi.fn().mockResolvedValue({
					stdout: "",
					stderr: "",
					exitCode: null,
					signal: "SIGTERM",
				}),
				now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(60),
				createSessionId: () => sessionId,
			},
		);

		const result = await runtime.runInteractive({ cwd: "/tmp/slice" });

		expect(result).toEqual({
			success: false,
			output: "Claude CLI terminated with signal SIGTERM.",
			sessionId,
			costUsd: 0,
			durationMs: 50,
			error: "Claude CLI terminated with signal SIGTERM.",
		});
	});

	it("injects RFC artifact writing instruction into the system prompt when rfcArtifactPath is provided", async () => {
		const sessionId = "sess-rfc-cc-1";
		const runClaudeCli = vi.fn().mockResolvedValue({
			stdout: "",
			stderr: "",
			exitCode: 0,
			signal: null,
		});
		const runtime = new ClaudeCodeRuntime(
			{},
			{
				runClaudeCli,
				now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(50),
				createSessionId: () => sessionId,
			},
		);

		await runtime.runInteractive({
			cwd: "/tmp/slice",
			prompt: "Draft the RFC.",
			rfcArtifactPath: "/tmp/implementations/my-feature-rfc-draft.md",
		});

		expect(runClaudeCli).toHaveBeenCalledWith({
			command: "claude",
			args: [
				"--session-id",
				sessionId,
				"--append-system-prompt",
				"When you are done, write the complete RFC draft as a Markdown document to:\n/tmp/implementations/my-feature-rfc-draft.md",
				"Task:\nDraft the RFC.",
			],
			cwd: "/tmp/slice",
			method: "runInteractive",
			stdio: "inherit",
		});
	});

	it("reads the RFC artifact file and returns its content as output after a successful session", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "claude-code-rfc-read-"));
		const rfcPath = join(cwd, "my-feature-rfc-draft.md");
		const rfcContent = "# RFC Draft\n\nThis is the RFC content.";
		const sessionId = "sess-rfc-cc-read-1";
		const runClaudeCli = vi.fn().mockResolvedValue({
			stdout: "",
			stderr: "",
			exitCode: 0,
			signal: null,
		});
		const runtime = new ClaudeCodeRuntime(
			{},
			{
				runClaudeCli,
				now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(100),
				createSessionId: () => sessionId,
			},
		);

		try {
			await writeFile(rfcPath, rfcContent);

			const result = await runtime.runInteractive({
				cwd,
				prompt: "Draft the RFC.",
				rfcArtifactPath: rfcPath,
			});

			expect(result).toEqual({
				success: true,
				output: rfcContent,
				sessionId,
				costUsd: 0,
				durationMs: 100,
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("returns empty output when the RFC artifact file was not written by the agent", async () => {
		const sessionId = "sess-rfc-cc-missing";
		const runtime = new ClaudeCodeRuntime(
			{},
			{
				runClaudeCli: vi.fn().mockResolvedValue({
					stdout: "",
					stderr: "",
					exitCode: 0,
					signal: null,
				}),
				now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(50),
				createSessionId: () => sessionId,
			},
		);

		const result = await runtime.runInteractive({
			cwd: "/tmp/slice",
			rfcArtifactPath: "/tmp/slice/implementations/nonexistent-rfc-draft.md",
		});

		expect(result).toEqual({
			success: true,
			output: "",
			sessionId,
			costUsd: 0,
			durationMs: 50,
		});
	});

	it("emits text_output progress events as stdout chunks arrive", async () => {
		const onProgress = vi.fn();
		const runtime = new ClaudeCodeRuntime(
			{},
			{
				runClaudeCli: vi
					.fn()
					.mockImplementation(({ onStdout }: { onStdout?: (chunk: string) => void }) => {
						onStdout?.("Partial output chunk 1");
						onStdout?.("Partial output chunk 2");
						return Promise.resolve({
							stdout: "Final output",
							stderr: "",
							exitCode: 0,
							signal: null,
						});
					}),
				now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(10),
				createSessionId: () => "sess-text-output",
			},
		);

		await runtime.run({ prompt: "Implement Slice 02", cwd: "/tmp/slice", onProgress });

		expect(onProgress).toHaveBeenCalledWith({ type: "agent_start" });
		expect(onProgress).toHaveBeenCalledWith({
			type: "text_output",
			text: "Partial output chunk 1",
		});
		expect(onProgress).toHaveBeenCalledWith({
			type: "text_output",
			text: "Partial output chunk 2",
		});
	});

	it("emits an error progress event when the CLI exits with a non-zero code", async () => {
		const onProgress = vi.fn();
		const runtime = new ClaudeCodeRuntime(
			{},
			{
				runClaudeCli: vi.fn().mockResolvedValue({
					stdout: "Partial output",
					stderr: "Claude reported a failure",
					exitCode: 2,
					signal: null,
				}),
				now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(60),
				createSessionId: () => "sess-progress-nonzero",
			},
		);

		await runtime.run({ prompt: "Implement Slice 02", cwd: "/tmp/slice", onProgress });

		expect(onProgress).toHaveBeenNthCalledWith(1, { type: "agent_start" });
		expect(onProgress).toHaveBeenNthCalledWith(2, {
			type: "error",
			message: "Claude reported a failure",
		});
	});

	it("skips RFC artifact reading when the interactive session fails", async () => {
		const sessionId = "sess-rfc-cc-fail";
		const runtime = new ClaudeCodeRuntime(
			{},
			{
				runClaudeCli: vi.fn().mockResolvedValue({
					stdout: "",
					stderr: "",
					exitCode: null,
					signal: "SIGTERM",
				}),
				now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(50),
				createSessionId: () => sessionId,
			},
		);

		const result = await runtime.runInteractive({
			cwd: "/tmp/slice",
			rfcArtifactPath: "/tmp/slice/implementations/my-feature-rfc-draft.md",
		});

		expect(result).toEqual({
			success: false,
			output: "Claude CLI terminated with signal SIGTERM.",
			sessionId,
			costUsd: 0,
			durationMs: 50,
			error: "Claude CLI terminated with signal SIGTERM.",
		});
	});

	it("merges rfcArtifactPath instruction with an existing system prompt", async () => {
		const sessionId = "sess-rfc-cc-2";
		const runClaudeCli = vi.fn().mockResolvedValue({
			stdout: "",
			stderr: "",
			exitCode: 0,
			signal: null,
		});
		const runtime = new ClaudeCodeRuntime(
			{},
			{
				runClaudeCli,
				now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(50),
				createSessionId: () => sessionId,
			},
		);

		await runtime.runInteractive({
			cwd: "/tmp/slice",
			prompt: "Draft the RFC.",
			systemPrompt: "Stay focused on the task.",
			rfcArtifactPath: "/tmp/implementations/my-feature-rfc-draft.md",
		});

		expect(runClaudeCli).toHaveBeenCalledWith({
			command: "claude",
			args: [
				"--session-id",
				sessionId,
				"--append-system-prompt",
				"Stay focused on the task.\n\nWhen you are done, write the complete RFC draft as a Markdown document to:\n/tmp/implementations/my-feature-rfc-draft.md",
				"Task:\nDraft the RFC.",
			],
			cwd: "/tmp/slice",
			method: "runInteractive",
			stdio: "inherit",
		});
	});
});
