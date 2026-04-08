import { mkdtempSync, rmSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunResult } from "../../runtime/types";
import type { WorkflowRun } from "../../state/types";
import { runDraftPolishPhase } from "./draft-polish";
import type { PhaseContext } from "./types";

describe("runDraftPolishPhase", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns completed with polished artifact path when autonomous run succeeds", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-draft-polish-success-"));
		roots.push(root);

		const inputPath = join(root, "implementations", "demo-slug", "rfc-draft.md");
		const outputPath = join(root, "implementations", "demo-slug", "rfc.md");
		await mkdir(dirname(inputPath), { recursive: true });
		await writeFile(inputPath, "# RFC Draft\n\nDraft content.");

		const runtimeResult: AgentRunResult = {
			success: true,
			output: "",
			sessionId: "sess-polish-1",
			costUsd: 0.88,
			durationMs: 3456,
		};

		const runtime = {
			run: vi.fn(
				async (options: {
					contextFiles?: string[];
					prompt?: string;
					onProgress?: unknown;
					allowedTools?: string[];
				}) => {
					expect(options.contextFiles).toEqual([inputPath]);
					expect(options.prompt).toContain(`Required output file path:\n${outputPath}`);
					expect(options.onProgress).toEqual(expect.any(Function));
					expect(options.allowedTools).toEqual(
						expect.arrayContaining(["Read", "Write", "Edit", "MultiEdit", "Bash(*)", "WebSearch"]),
					);
					await writeFile(outputPath, "# RFC\n\nPolished content.");
					return runtimeResult;
				},
			),
		};

		const context = makePhaseContext(root, {
			runtime,
			promptBuilder: {
				system: "System draft-polish instructions",
				task: "Refine the RFC draft and remove ambiguity.",
			},
		});

		const result = await runDraftPolishPhase(context);

		expect(result).toEqual({
			status: "completed",
			agentSessionId: runtimeResult.sessionId,
			costUsd: runtimeResult.costUsd,
			durationMs: runtimeResult.durationMs,
			error: null,
			output: outputPath,
		});
		await expect(access(outputPath)).resolves.toBeUndefined();
	});

	it("returns failed when required rfc-draft.md input is missing", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-draft-polish-missing-input-"));
		roots.push(root);
		const runtimeRun = vi.fn();
		const context = makePhaseContext(root, {
			runtime: { run: runtimeRun },
		});

		const result = await runDraftPolishPhase(context);
		const expectedInput = join(root, "implementations", "demo-slug", "rfc-draft.md");

		expect(result.status).toBe("failed");
		expect(result.error).toContain(expectedInput);
		expect(result.error).toContain("requires an RFC draft");
		expect(runtimeRun).not.toHaveBeenCalled();
	});

	it("returns failed and propagates runtime failure details", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-draft-polish-runtime-failed-"));
		roots.push(root);
		const inputPath = join(root, "implementations", "demo-slug", "rfc-draft.md");
		await mkdir(dirname(inputPath), { recursive: true });
		await writeFile(inputPath, "# Draft");

		const context = makePhaseContext(root, {
			runtime: {
				run: vi.fn().mockResolvedValue({
					success: false,
					output: "agent output",
					sessionId: "sess-polish-fail",
					costUsd: 0.4,
					durationMs: 800,
					error: "autonomous polish aborted",
				} satisfies AgentRunResult),
			},
		});

		const result = await runDraftPolishPhase(context);

		expect(result).toEqual({
			status: "failed",
			agentSessionId: "sess-polish-fail",
			costUsd: 0.4,
			durationMs: 800,
			error: "autonomous polish aborted",
			output: null,
		});
	});

	it("returns failed when runtime.run throws", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-draft-polish-runtime-throw-"));
		roots.push(root);
		const inputPath = join(root, "implementations", "demo-slug", "rfc-draft.md");
		await mkdir(dirname(inputPath), { recursive: true });
		await writeFile(inputPath, "# Draft");

		const context = makePhaseContext(root, {
			runtime: {
				run: vi.fn().mockRejectedValue(new Error("OpenCode server unavailable")),
			},
		});

		const result = await runDraftPolishPhase(context);

		expect(result).toEqual({
			status: "failed",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			error: "draft polish run failed: OpenCode server unavailable",
			output: null,
		});
	});

	it("returns failed when runtime succeeds but polished artifact is missing", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-draft-polish-missing-output-"));
		roots.push(root);
		const inputPath = join(root, "implementations", "demo-slug", "rfc-draft.md");
		await mkdir(dirname(inputPath), { recursive: true });
		await writeFile(inputPath, "# Draft");

		const context = makePhaseContext(root, {
			runtime: {
				run: vi.fn().mockResolvedValue({
					success: true,
					output: "",
					sessionId: "sess-polish-ok",
					costUsd: 0.2,
					durationMs: 650,
				} satisfies AgentRunResult),
			},
		});

		const result = await runDraftPolishPhase(context);
		const expectedOutput = join(root, "implementations", "demo-slug", "rfc.md");

		expect(result.status).toBe("failed");
		expect(result.agentSessionId).toBe("sess-polish-ok");
		expect(result.costUsd).toBe(0.2);
		expect(result.durationMs).toBe(650);
		expect(result.output).toBeNull();
		expect(result.error).toContain(expectedOutput);
		expect(result.error).toContain("was not created");
	});

	it("persists fallback output when runtime succeeds and returns markdown text", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-draft-polish-fallback-output-"));
		roots.push(root);
		const inputPath = join(root, "implementations", "demo-slug", "rfc-draft.md");
		const outputPath = join(root, "implementations", "demo-slug", "rfc.md");
		await mkdir(dirname(inputPath), { recursive: true });
		await writeFile(inputPath, "# Draft");

		const context = makePhaseContext(root, {
			runtime: {
				run: vi.fn().mockResolvedValue({
					success: true,
					output: "```markdown\n# RFC\n\nPolished from fallback.\n```",
					sessionId: "sess-polish-fallback",
					costUsd: 0.3,
					durationMs: 720,
				} satisfies AgentRunResult),
			},
		});

		const result = await runDraftPolishPhase(context);
		const outputContent = await readFile(outputPath, "utf-8");

		expect(result.status).toBe("completed");
		expect(result.output).toBe(outputPath);
		expect(outputContent).toContain("# RFC");
		expect(outputContent).toContain("Polished from fallback.");
	});

	it("fails explicitly on permission-denied output and does not persist denial text", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-draft-polish-permission-denied-"));
		roots.push(root);
		const inputPath = join(root, "implementations", "demo-slug", "rfc-draft.md");
		const outputPath = join(root, "implementations", "demo-slug", "rfc.md");
		await mkdir(dirname(inputPath), { recursive: true });
		await writeFile(inputPath, "# Draft");

		const context = makePhaseContext(root, {
			runtime: {
				run: vi.fn().mockResolvedValue({
					success: true,
					output: `The write to '${outputPath}' was denied. Please grant write permission to that path so I can complete the task.`,
					sessionId: "sess-polish-denied",
					costUsd: 0.5,
					durationMs: 900,
				} satisfies AgentRunResult),
			},
		});

		const result = await runDraftPolishPhase(context);

		expect(result.status).toBe("failed");
		expect(result.output).toBeNull();
		expect(result.error).toContain("runtime permission denial");
		await expect(access(outputPath)).rejects.toThrow();
	});
});

function makePhaseContext(
	projectCwd: string,
	options?: {
		runtime?: { run?: ReturnType<typeof vi.fn> };
		promptBuilder?: { system?: string; task?: string };
	},
): PhaseContext {
	const run: WorkflowRun = {
		id: "run-1",
		taskDescription: "Polish the RFC draft",
		slug: "demo-slug",
		status: "running",
		currentPhase: "draft-polish",
		baseBranch: "main",
		workingBranch: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	return {
		runId: run.id,
		run,
		phase: "draft-polish",
		config: {} as PhaseContext["config"],
		runtime: {
			provider: "claude-code",
			run:
				options?.runtime?.run ??
				vi.fn().mockResolvedValue({
					success: true,
					output: "",
					sessionId: "sess-default",
					costUsd: 0,
					durationMs: 1,
				} satisfies AgentRunResult),
			runInteractive: vi.fn(),
		},
		state: {} as PhaseContext["state"],
		worktree: {} as PhaseContext["worktree"],
		messaging: {} as PhaseContext["messaging"],
		prompts: {
			buildPrompt: vi.fn().mockResolvedValue({
				phase: "draft-polish",
				layers: {
					system: options?.promptBuilder?.system ?? "Draft polish system prompt",
					context: "",
					task: options?.promptBuilder?.task ?? "Draft polish task prompt",
				},
				composedPrompt: "",
			}),
			buildSystemPrompt: vi
				.fn()
				.mockResolvedValue(options?.promptBuilder?.system ?? "Draft polish system prompt"),
			buildTaskPrompt: vi
				.fn()
				.mockResolvedValue(options?.promptBuilder?.task ?? "Draft polish task prompt"),
		},
		projectCwd,
		implementationsDir: join(projectCwd, "implementations"),
		resumeContext: undefined,
		onEvent: undefined,
	};
}
