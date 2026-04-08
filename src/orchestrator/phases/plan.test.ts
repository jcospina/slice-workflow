import { mkdtempSync, rmSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunResult } from "../../runtime/types";
import type { WorkflowRun } from "../../state/types";
import { runPlanPhase, runPlanWithInputs } from "./plan";
import type { PhaseContext } from "./types";

describe("runPlanPhase", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns completed when session exits successfully and plan file is written", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-plan-phase-success-"));
		roots.push(root);

		const runtimeResult: AgentRunResult = {
			success: true,
			output: "",
			sessionId: "sess-plan-1",
			costUsd: 2.5,
			durationMs: 8000,
		};

		const runtime = {
			runInteractive: vi.fn(async () => {
				const artifactPath = join(root, "implementations", "demo-slug", "demo-slug.md");
				await writeFile(artifactPath, "# Demo Slug Plan\n\nSlice 00: Foundation\n");
				return runtimeResult;
			}),
		};

		const context = makePhaseContext(root, { runtime });
		const result = await runPlanPhase(context);
		const expectedArtifact = join(root, "implementations", "demo-slug", "demo-slug.md");

		expect(result).toEqual({
			status: "completed",
			agentSessionId: runtimeResult.sessionId,
			costUsd: runtimeResult.costUsd,
			durationMs: runtimeResult.durationMs,
			error: null,
			output: expectedArtifact,
		});
		// No rfcArtifactPath — plan instructions live in the system prompt
		expect(context.runtime.runInteractive).toHaveBeenCalledWith(
			expect.not.objectContaining({ rfcArtifactPath: expect.anything() }),
		);
		await expect(access(expectedArtifact)).resolves.toBeUndefined();
	});

	it("includes rfc path in prompt when rfc.md exists", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-plan-phase-rfc-context-"));
		roots.push(root);

		const implDir = join(root, "implementations", "demo-slug");
		await mkdir(implDir, { recursive: true });
		const rfcPath = join(implDir, "rfc.md");
		await writeFile(rfcPath, "# Polished RFC\n\nRequirements...\n");

		const runtime = {
			runInteractive: vi.fn(async () => {
				await writeFile(join(implDir, "demo-slug.md"), "# Plan\n");
				return { success: true, output: "", sessionId: "sess-rfc", costUsd: 0, durationMs: 0 };
			}),
		};

		const context = makePhaseContext(root, { runtime });
		await runPlanPhase(context);

		const call = vi.mocked(context.runtime.runInteractive).mock.calls[0][0];
		expect(call.prompt).toContain(rfcPath);
		expect(call).not.toHaveProperty("contextFiles");
	});

	it("includes explicit rfcPath in prompt when provided via runPlanWithInputs", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-plan-phase-explicit-rfc-"));
		roots.push(root);

		const explicitRfc = join(root, "custom", "polished.md");
		await mkdir(join(root, "custom"), { recursive: true });
		await writeFile(explicitRfc, "# Custom RFC\n");

		const runtime = {
			runInteractive: vi.fn(async () => {
				const artifactPath = join(root, "implementations", "demo-slug", "demo-slug.md");
				await writeFile(artifactPath, "# Plan\n");
				return { success: true, output: "", sessionId: "sess-explicit", costUsd: 0, durationMs: 0 };
			}),
		};

		const context = makePhaseContext(root, { runtime });
		await runPlanWithInputs(context, { rfcPath: explicitRfc });

		const call = vi.mocked(context.runtime.runInteractive).mock.calls[0][0];
		expect(call.prompt).toContain(explicitRfc);
		expect(call).not.toHaveProperty("contextFiles");
	});

	it("omits rfc path from prompt when rfc.md does not exist", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-plan-phase-no-rfc-"));
		roots.push(root);

		const runtime = {
			runInteractive: vi.fn(async () => {
				const artifactPath = join(root, "implementations", "demo-slug", "demo-slug.md");
				await writeFile(artifactPath, "# Plan\n");
				return { success: true, output: "", sessionId: "sess-no-rfc", costUsd: 0, durationMs: 0 };
			}),
		};

		const context = makePhaseContext(root, { runtime });
		await runPlanPhase(context);

		const call = vi.mocked(context.runtime.runInteractive).mock.calls[0][0];
		expect(call.prompt).not.toContain("rfc.md");
		expect(call).not.toHaveProperty("contextFiles");
	});

	it("returns completed when session exits with failure (ctrl+c) but plan file was already written", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-plan-phase-ctrlc-written-"));
		roots.push(root);

		const runtimeResult: AgentRunResult = {
			success: false,
			output: "",
			sessionId: "sess-plan-ctrlc",
			costUsd: 1.0,
			durationMs: 3000,
		};

		const runtime = {
			runInteractive: vi.fn(async () => {
				// Simulate: agent wrote plan, user ctrl+c'd
				const artifactPath = join(root, "implementations", "demo-slug", "demo-slug.md");
				await writeFile(artifactPath, "# Demo Slug Plan\n\nApproved plan content.\n");
				return runtimeResult;
			}),
		};

		const context = makePhaseContext(root, { runtime });
		const result = await runPlanPhase(context);

		expect(result.status).toBe("completed");
		expect(result.agentSessionId).toBe("sess-plan-ctrlc");
	});

	it("returns failed with agent-exit hint when session succeeds but plan file is missing", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-plan-phase-missing-artifact-success-"));
		roots.push(root);

		const context = makePhaseContext(root, {
			runtime: {
				runInteractive: vi.fn().mockResolvedValue({
					success: true,
					output: "",
					sessionId: "sess-plan-ok",
					costUsd: 0.3,
					durationMs: 900,
				} satisfies AgentRunResult),
			},
		});

		const result = await runPlanPhase(context);
		const expectedArtifact = join(root, "implementations", "demo-slug", "demo-slug.md");

		expect(result.status).toBe("failed");
		expect(result.agentSessionId).toBe("sess-plan-ok");
		expect(result.costUsd).toBe(0.3);
		expect(result.durationMs).toBe(900);
		expect(result.output).toBeNull();
		expect(result.error).toContain(expectedArtifact);
		expect(result.error).toContain("exited without writing the plan");
	});

	it("returns failed with interruption hint when session exits with failure and plan file is missing", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-plan-phase-missing-artifact-ctrlc-"));
		roots.push(root);

		const context = makePhaseContext(root, {
			runtime: {
				runInteractive: vi.fn().mockResolvedValue({
					success: false,
					output: "",
					sessionId: "sess-plan-interrupted",
					costUsd: 0.1,
					durationMs: 500,
				} satisfies AgentRunResult),
			},
		});

		const result = await runPlanPhase(context);

		expect(result.status).toBe("failed");
		expect(result.agentSessionId).toBe("sess-plan-interrupted");
		expect(result.error).toContain("interrupted");
	});

	it("returns failed when runInteractive throws", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-plan-phase-runtime-throw-"));
		roots.push(root);

		const context = makePhaseContext(root, {
			runtime: {
				runInteractive: vi.fn().mockRejectedValue(new Error("Claude CLI not found")),
			},
		});

		const result = await runPlanPhase(context);

		expect(result).toEqual({
			status: "failed",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			error: "Plan interactive session failed: Claude CLI not found",
			output: null,
		});
	});

	it("returns failed when prompt build throws", async () => {
		const root = mkdtempSync(join(tmpdir(), "slice-plan-phase-prompt-throw-"));
		roots.push(root);

		const context = makePhaseContext(root, {
			promptBuilder: { buildSystemPromptError: new Error("Template render failed") },
		});

		const result = await runPlanPhase(context);

		expect(result).toEqual({
			status: "failed",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			error: "Failed to build plan prompt: Template render failed",
			output: null,
		});
	});
});

function makePhaseContext(
	projectCwd: string,
	options?: {
		runtime?: { runInteractive: ReturnType<typeof vi.fn> };
		promptBuilder?: {
			system?: string;
			task?: string;
			buildSystemPromptError?: Error;
		};
	},
): PhaseContext {
	const run: WorkflowRun = {
		id: "run-1",
		taskDescription: "Build a plan",
		slug: "demo-slug",
		status: "running",
		currentPhase: "plan",
		baseBranch: "main",
		workingBranch: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	const buildSystemPrompt = options?.promptBuilder?.buildSystemPromptError
		? vi.fn().mockRejectedValue(options.promptBuilder.buildSystemPromptError)
		: vi.fn().mockResolvedValue(options?.promptBuilder?.system ?? "Plan system prompt");

	return {
		runId: run.id,
		run,
		phase: "plan",
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
			buildSystemPrompt,
			buildTaskPrompt: vi
				.fn()
				.mockResolvedValue(options?.promptBuilder?.task ?? "Plan task prompt"),
		},
		projectCwd,
		implementationsDir: join(projectCwd, "implementations"),
		resumeContext: undefined,
		onEvent: undefined,
	};
}
