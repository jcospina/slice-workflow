import { mkdtempSync, rmSync } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunResult } from "../../runtime/types";
import type { WorkflowRun } from "../../state/types";
import { runRfcDraftPhase } from "./rfc-draft";
import type { PhaseContext } from "./types";

describe("runRfcDraftPhase", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns completed with artifact path when interactive run succeeds and writes RFC file", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-rfc-phase-success-"));
		roots.push(root);

		const runtimeResult: AgentRunResult = {
			success: true,
			output: "",
			sessionId: "sess-rfc-1",
			costUsd: 1.23,
			durationMs: 4567,
		};

		const runtime = {
			runInteractive: vi.fn(async (options: { prompt?: string; rfcArtifactPath?: string }) => {
				expect(options.prompt).toContain("Workflow task description:\nBuild RFC workflow");
				expect(options.prompt).toContain("Generate a complete Markdown RFC body for approval.");
				expect(options.rfcArtifactPath).toBeDefined();
				await writeFile(
					options.rfcArtifactPath as string,
					"# RFC Draft\n\nThis file is produced by the interactive phase.",
				);
				return runtimeResult;
			}),
		};

		const context = makePhaseContext(root, {
			runtime,
			promptBuilder: {
				system: "System RFC instructions",
				task: "Generate a complete Markdown RFC body for approval.",
			},
		});

		const result = await runRfcDraftPhase(context);
		const expectedArtifact = join(root, "implementations", "demo-slug", "rfc-draft.md");

		expect(result).toEqual({
			status: "completed",
			agentSessionId: runtimeResult.sessionId,
			costUsd: runtimeResult.costUsd,
			durationMs: runtimeResult.durationMs,
			error: null,
			output: expectedArtifact,
		});
		expect(context.runtime.runInteractive).toHaveBeenCalledWith({
			cwd: root,
			systemPrompt: "System RFC instructions",
			prompt: [
				"Workflow task description:\nBuild RFC workflow",
				"Generate a complete Markdown RFC body for approval.",
			].join("\n\n"),
			rfcArtifactPath: expectedArtifact,
		});
		await expect(access(expectedArtifact)).resolves.toBeUndefined();
	});

	it("returns failed and propagates runtime failure details", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-rfc-phase-runtime-failed-"));
		roots.push(root);

		const context = makePhaseContext(root, {
			runtime: {
				runInteractive: vi.fn().mockResolvedValue({
					success: false,
					output: "agent output",
					sessionId: "sess-rfc-fail",
					costUsd: 0.5,
					durationMs: 1000,
					error: "interactive session aborted",
				} satisfies AgentRunResult),
			},
		});

		const result = await runRfcDraftPhase(context);

		expect(result).toEqual({
			status: "failed",
			agentSessionId: "sess-rfc-fail",
			costUsd: 0.5,
			durationMs: 1000,
			error: "interactive session aborted",
			output: null,
		});
	});

	it("returns failed when interactive run succeeds but RFC artifact file is missing", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-rfc-phase-missing-artifact-"));
		roots.push(root);

		const context = makePhaseContext(root, {
			runtime: {
				runInteractive: vi.fn().mockResolvedValue({
					success: true,
					output: "",
					sessionId: "sess-rfc-ok",
					costUsd: 0.2,
					durationMs: 800,
				} satisfies AgentRunResult),
			},
		});

		const result = await runRfcDraftPhase(context);
		const expectedArtifact = join(root, "implementations", "demo-slug", "rfc-draft.md");

		expect(result.status).toBe("failed");
		expect(result.agentSessionId).toBe("sess-rfc-ok");
		expect(result.costUsd).toBe(0.2);
		expect(result.durationMs).toBe(800);
		expect(result.output).toBeNull();
		expect(result.error).toContain(expectedArtifact);
		expect(result.error).toContain("was not created");
	});

	it("returns failed when runInteractive throws", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-rfc-phase-runtime-throw-"));
		roots.push(root);

		const context = makePhaseContext(root, {
			runtime: {
				runInteractive: vi.fn().mockRejectedValue(new Error("Claude CLI not found")),
			},
		});

		const result = await runRfcDraftPhase(context);

		expect(result).toEqual({
			status: "failed",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			error: "RFC draft interactive session failed: Claude CLI not found",
			output: null,
		});
	});
});

function makePhaseContext(
	projectCwd: string,
	options?: {
		runtime?: { runInteractive: ReturnType<typeof vi.fn> };
		promptBuilder?: { system?: string; task?: string };
	},
): PhaseContext {
	const run: WorkflowRun = {
		id: "run-1",
		taskDescription: "Build RFC workflow",
		slug: "demo-slug",
		status: "running",
		currentPhase: "rfc-draft",
		baseBranch: "main",
		workingBranch: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	return {
		runId: run.id,
		run,
		phase: "rfc-draft",
		config: {} as PhaseContext["config"],
		runtime: {
			provider: "claude-code",
			run: vi.fn(),
			runInteractive:
				options?.runtime?.runInteractive ??
				vi.fn().mockResolvedValue({
					success: true,
					output: "",
					sessionId: "sess-default",
					costUsd: 0,
					durationMs: 1,
				} satisfies AgentRunResult),
		},
		state: {} as PhaseContext["state"],
		worktree: {} as PhaseContext["worktree"],
		messaging: {} as PhaseContext["messaging"],
		prompts: {
			buildPrompt: vi.fn(),
			buildSystemPrompt: vi
				.fn()
				.mockResolvedValue(options?.promptBuilder?.system ?? "RFC system prompt"),
			buildTaskPrompt: vi.fn().mockResolvedValue(options?.promptBuilder?.task ?? "RFC task prompt"),
		},
		projectCwd,
		implementationsDir: join(projectCwd, "implementations"),
		resumeContext: undefined,
		onEvent: undefined,
	};
}
