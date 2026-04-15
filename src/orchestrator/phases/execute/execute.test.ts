import { copyFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunResult } from "../../../runtime/types";
import type { SliceRecord, WorkflowRun } from "../../../state/types";
import type { OrchestratorEvent, PhaseContext } from "../types";
import { findTrackFile, parsePlanSlices, parseReviewOutput, runExecutePhase } from "./index";

// --- Mock node:fs/promises ---

vi.mock("node:fs/promises", () => ({
	readFile: vi.fn(),
	readdir: vi.fn(),
	copyFile: vi.fn(),
}));

const mockReadFile = vi.mocked(readFile);
const mockReaddir = vi.mocked(readdir);
const mockCopyFile = vi.mocked(copyFile);

// --- Sample plan document content ---

const SAMPLE_PLAN = `
# Demo Slug Plan

## Goal
Do the thing.

## Sliced Roadmap (00-02)

### Slice 00 - Foundation
Goal:
- Set up the base structure.

Definition of Done:
- Base files created.
- Types defined.

### Slice 01 - Runtime Scaffold
Goal:
- Add the scaffold.

Definition of Done:
- Scaffold module exists with correct surface.
- Tests cover identity.

### Slice 02 - Consolidation
Goal:
- Finalize.
`.trim();

const PLAN_WITH_MISSING_DOD = `
### Slice 00 - Foundation
Goal: Just goal, no DoD.

### Slice 01 - Next
Definition of Done:
- Item A.
`.trim();

// --- Helpers ---

function makeSliceRecord(
	overrides: Partial<SliceRecord> & { id: string; index: number; name: string },
): SliceRecord {
	return {
		runId: "run-1",
		status: "pending",
		agentSessionId: null,
		costUsd: null,
		durationMs: null,
		turnsUsed: null,
		error: null,
		startedAt: null,
		endedAt: null,
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function makeSuccessResult(overrides?: Partial<AgentRunResult>): AgentRunResult {
	return {
		success: true,
		output: "done",
		sessionId: "sess-1",
		costUsd: 0.5,
		durationMs: 1000,
		...overrides,
	};
}

function makePhaseContext(overrides?: {
	runtime?: Partial<PhaseContext["runtime"]>;
	worktree?: Partial<PhaseContext["worktree"]>;
	stateSlices?: Partial<PhaseContext["state"]["slices"]>;
	stateRuns?: Partial<PhaseContext["state"]["runs"]>;
	stateReviews?: Partial<PhaseContext["state"]["reviews"]>;
	messaging?: Partial<PhaseContext["messaging"]>;
	prompts?: Partial<PhaseContext["prompts"]>;
	onEvent?: PhaseContext["onEvent"];
	workingBranch?: string | null;
	reviewEnabled?: boolean;
	sliceExecution?: "autonomous" | "gated";
}): PhaseContext {
	const run: WorkflowRun = {
		id: "run-1",
		taskDescription: "Build something",
		slug: "demo-slug",
		status: "running",
		currentPhase: "execute",
		baseBranch: "main",
		workingBranch: overrides?.workingBranch ?? null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	return {
		runId: run.id,
		run,
		phase: "execute",
		config: {
			implementationsDir: "implementations",
			providers: { claudeCode: {}, opencode: {} },
			sliceExecution: overrides?.sliceExecution ?? "autonomous",
			execution: { maxTurnsPerSlice: 50, maxTurnsPerReview: 20 },
			review: {
				enabled: overrides?.reviewEnabled ?? false,
				maxIterations: 2,
				severityThreshold: "major",
				adversarial: true,
			},
		} as unknown as PhaseContext["config"],
		runtime: {
			provider: "claude-code",
			run: vi.fn().mockResolvedValue(makeSuccessResult()),
			runInteractive: vi.fn(),
			...overrides?.runtime,
		},
		state: {
			slices: {
				getByIndex: vi.fn(),
				create: vi.fn(),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
				...overrides?.stateSlices,
			},
			runs: {
				update: vi.fn(),
				...overrides?.stateRuns,
			},
			reviews: {
				countBySlice: vi.fn().mockReturnValue(0),
				create: vi.fn().mockReturnValue({ id: "rev-1" }),
				...overrides?.stateReviews,
			},
			getRunCostSummary: vi.fn().mockReturnValue({
				totalCostUsd: 0,
				totalDurationMs: 0,
				slicesCompleted: 0,
				slicesTotal: 0,
			}),
		} as unknown as PhaseContext["state"],
		worktree: {
			create: vi.fn().mockResolvedValue("/fake/worktree"),
			setup: vi.fn().mockResolvedValue(undefined),
			remove: vi.fn().mockResolvedValue(undefined),
			prune: vi.fn().mockResolvedValue(undefined),
			...overrides?.worktree,
		},
		messaging: {
			requestApproval: vi.fn().mockResolvedValue({
				decision: "approved",
				feedback: null,
				respondedAt: new Date().toISOString(),
				channel: "tui",
			}),
			close: vi.fn().mockResolvedValue(undefined),
			...overrides?.messaging,
		},
		prompts: {
			buildPrompt: vi.fn().mockResolvedValue({
				phase: "slice-execution",
				layers: {
					system: "System instructions",
					context: "Context block",
					task: "Task instructions",
				},
				composedPrompt: "System instructions\n\nContext block\n\nTask instructions",
			}),
			buildSystemPrompt: vi.fn(),
			buildTaskPrompt: vi.fn(),
			...overrides?.prompts,
		},
		projectCwd: "/project",
		implementationsDir: "/project/implementations",
		resumeContext: undefined,
		onEvent: overrides?.onEvent,
	};
}

// =============================================================================
// parsePlanSlices — unit tests (pure function)
// =============================================================================

describe("parsePlanSlices", () => {
	it("parses standard plan with multiple slices", () => {
		const result = parsePlanSlices(SAMPLE_PLAN);

		expect(result).toHaveLength(3);

		expect(result[0]).toEqual({
			index: 0,
			name: "Foundation",
			dod: "- Base files created.\n- Types defined.",
		});

		expect(result[1]).toEqual({
			index: 1,
			name: "Runtime Scaffold",
			dod: "- Scaffold module exists with correct surface.\n- Tests cover identity.",
		});

		expect(result[2]).toMatchObject({
			index: 2,
			name: "Consolidation",
		});
	});

	it("returns empty dod when Definition of Done section is absent", () => {
		const result = parsePlanSlices(PLAN_WITH_MISSING_DOD);

		expect(result).toHaveLength(2);
		expect(result[0].dod).toBe("");
		expect(result[1].dod).toBe("- Item A.");
	});

	it("returns empty array for content with no slice headers", () => {
		const result = parsePlanSlices("# Just a title\n\nNo slices here.");
		expect(result).toEqual([]);
	});

	it("returns empty array for empty string", () => {
		expect(parsePlanSlices("")).toEqual([]);
	});

	it("parses numeric index correctly regardless of leading zeros", () => {
		const content = "### Slice 05 - Fifth\nDefinition of Done:\n- Done.";
		const result = parsePlanSlices(content);

		expect(result).toHaveLength(1);
		expect(result[0].index).toBe(5);
		expect(result[0].name).toBe("Fifth");
	});

	it("trims names and dod content", () => {
		const content = "### Slice 00 -   Leading Space  \nDefinition of Done:\n  - item  \n";
		const result = parsePlanSlices(content);

		expect(result[0].name).toBe("Leading Space");
		expect(result[0].dod).toBe("- item");
	});
});

// =============================================================================
// findTrackFile
// =============================================================================

describe("findTrackFile", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns absolute path when matching track file exists", async () => {
		mockReaddir.mockResolvedValue([
			"00-foundation.md",
			"01-scaffold.md",
			"02-consolidation.md",
		] as unknown as Awaited<ReturnType<typeof readdir>>);

		const result = await findTrackFile("/project/implementations/demo/tracks", 1);
		expect(result).toBe(join("/project/implementations/demo/tracks", "01-scaffold.md"));
	});

	it("returns null when no file matches the index prefix", async () => {
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const result = await findTrackFile("/project/implementations/demo/tracks", 5);
		expect(result).toBeNull();
	});

	it("returns null when the tracks directory does not exist", async () => {
		mockReaddir.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

		const result = await findTrackFile("/project/implementations/demo/tracks", 0);
		expect(result).toBeNull();
	});

	it("returns null when the directory is empty", async () => {
		mockReaddir.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof readdir>>);

		const result = await findTrackFile("/project/implementations/demo/tracks", 0);
		expect(result).toBeNull();
	});

	it("does not match files lacking the .md extension", async () => {
		mockReaddir.mockResolvedValue(["00-foundation.ts", "00-foundation.json"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const result = await findTrackFile("/project/implementations/demo/tracks", 0);
		expect(result).toBeNull();
	});
});

// =============================================================================
// runExecutePhase
// =============================================================================

describe("runExecutePhase", () => {
	const planPath = "/project/implementations/demo-slug/demo-slug.md";

	beforeEach(() => {
		vi.clearAllMocks();
		// Default: copyFile succeeds
		mockCopyFile.mockResolvedValue(undefined);
	});

	// ---------------------------------------------------------------------------
	// Plan loading failures
	// ---------------------------------------------------------------------------

	it("returns failed when plan document cannot be read", async () => {
		mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

		const ctx = makePhaseContext();
		const result = await runExecutePhase(ctx);

		expect(result.status).toBe("failed");
		expect(result.error).toContain(planPath);
		expect(vi.mocked(ctx.state.slices.create)).not.toHaveBeenCalled();
	});

	it("returns failed when plan has no slice headers", async () => {
		mockReadFile.mockResolvedValue("# Title\n\nNo slices here.");

		const ctx = makePhaseContext();
		const result = await runExecutePhase(ctx);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("No slice definitions found");
		expect(vi.mocked(ctx.state.slices.create)).not.toHaveBeenCalled();
	});

	// ---------------------------------------------------------------------------
	// Happy path — single slice
	// ---------------------------------------------------------------------------

	it("executes a single slice and returns completed", async () => {
		const singleSlicePlan = `
### Slice 00 - Foundation
Definition of Done:
- Base files created.
`.trim();

		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });

		const ctx = makePhaseContext({
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: vi.fn().mockImplementation((_id, updates) => ({ ...sliceRecord, ...updates })),
				listByRun: vi.fn().mockReturnValue([]),
			},
		});

		const result = await runExecutePhase(ctx);

		expect(result.status).toBe("completed");
		expect(result.error).toBeNull();
		expect(result.costUsd).toBe(0.5);
		expect(result.durationMs).toBe(1000);
		expect(result.agentSessionId).toBeNull();
	});

	it("marks slice running then completed on success", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const updateSpy = vi
			.fn()
			.mockImplementation((_id, updates) => ({ ...sliceRecord, ...updates }));

		const ctx = makePhaseContext({
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: updateSpy,
				listByRun: vi.fn().mockReturnValue([]),
			},
		});

		await runExecutePhase(ctx);

		// First update: status = "running"
		expect(updateSpy).toHaveBeenCalledWith(
			"slice-1",
			expect.objectContaining({ status: "running" }),
		);
		// Later update: status = "completed" with session/cost/duration
		expect(updateSpy).toHaveBeenCalledWith(
			"slice-1",
			expect.objectContaining({
				status: "completed",
				agentSessionId: "sess-1",
				costUsd: 0.5,
				durationMs: 1000,
			}),
		);
	});

	it("passes worktree path as agent cwd, not projectCwd", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const runSpy = vi.fn().mockResolvedValue(makeSuccessResult());

		const ctx = makePhaseContext({
			runtime: { run: runSpy },
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
		});

		await runExecutePhase(ctx);

		expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/fake/worktree" }));
	});

	it("passes system prompt and combined context+task as prompt to runtime", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const runSpy = vi.fn().mockResolvedValue(makeSuccessResult());

		const ctx = makePhaseContext({
			runtime: { run: runSpy },
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
		});

		await runExecutePhase(ctx);

		expect(runSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				systemPrompt: "System instructions",
				prompt: "Context block\n\nTask instructions",
			}),
		);
	});

	it("passes execution.maxTurnsPerSlice to runtime.run()", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const runSpy = vi.fn().mockResolvedValue(makeSuccessResult());

		const ctx = makePhaseContext({
			runtime: { run: runSpy },
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
		});
		ctx.config = {
			...ctx.config,
			execution: { maxTurnsPerSlice: 30, maxTurnsPerReview: 20 },
		} as unknown as typeof ctx.config;

		await runExecutePhase(ctx);

		expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({ maxTurns: 30 }));
	});

	it("passes default execution.maxTurnsPerSlice (50) when not overridden", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const runSpy = vi.fn().mockResolvedValue(makeSuccessResult());

		const ctx = makePhaseContext({
			runtime: { run: runSpy },
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
		});

		await runExecutePhase(ctx);

		expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({ maxTurns: 50 }));
	});

	it("updates workingBranch per-slice (not only at end)", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const runsUpdateSpy = vi.fn();

		const ctx = makePhaseContext({
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
			stateRuns: { update: runsUpdateSpy },
		});

		await runExecutePhase(ctx);

		// workingBranch is now updated immediately after each slice completes
		expect(runsUpdateSpy).toHaveBeenCalledWith(
			"run-1",
			expect.objectContaining({ workingBranch: "task/demo-slug-0" }),
		);
	});

	it("always removes the worktree even on agent failure", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const removeSpy = vi.fn().mockResolvedValue(undefined);

		const ctx = makePhaseContext({
			runtime: {
				run: vi.fn().mockResolvedValue({
					success: false,
					output: "agent failed",
					sessionId: "sess-fail",
					costUsd: 0.1,
					durationMs: 500,
					error: "agent failed",
				} satisfies AgentRunResult),
			},
			worktree: { remove: removeSpy },
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
		});

		await runExecutePhase(ctx);

		expect(removeSpy).toHaveBeenCalledWith("/fake/worktree");
	});

	it("emits slice_started and slice_completed events on success", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const events: unknown[] = [];

		const ctx = makePhaseContext({
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
			onEvent: (e) => events.push(e),
		});

		await runExecutePhase(ctx);

		expect(events).toContainEqual(
			expect.objectContaining({ type: "slice_started", sliceIndex: 0, sliceName: "Foundation" }),
		);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "slice_completed", sliceIndex: 0 }),
		);
	});

	// ---------------------------------------------------------------------------
	// Resume — completed slices skipped
	// ---------------------------------------------------------------------------

	it("skips completed slices and accumulates their cost", async () => {
		const twoPlan = `
### Slice 00 - Foundation
Definition of Done:
- Done.

### Slice 01 - Scaffold
Definition of Done:
- Done.
`.trim();

		mockReadFile.mockResolvedValue(twoPlan);
		mockReaddir.mockResolvedValue(["01-scaffold.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const completedRecord = makeSliceRecord({
			id: "slice-0",
			index: 0,
			name: "Foundation",
			status: "completed",
			costUsd: 1.5,
			durationMs: 2000,
		});
		const pendingRecord = makeSliceRecord({ id: "slice-1", index: 1, name: "Scaffold" });
		const runSpy = vi.fn().mockResolvedValue(makeSuccessResult({ costUsd: 0.3, durationMs: 500 }));

		const ctx = makePhaseContext({
			runtime: { run: runSpy },
			stateSlices: {
				getByIndex: vi
					.fn()
					.mockImplementation((_runId: string, index: number) =>
						index === 0 ? completedRecord : pendingRecord,
					),
				create: vi.fn(),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
		});

		const result = await runExecutePhase(ctx);

		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("completed");
		// Accumulated cost from both completed (1.5) and newly run (0.3) slices
		expect(result.costUsd).toBeCloseTo(1.8);
	});

	it("does not run the agent when all slices are already completed", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);

		const completedRecord = makeSliceRecord({
			id: "slice-0",
			index: 0,
			name: "Foundation",
			status: "completed",
			costUsd: 0.5,
			durationMs: 1000,
		});
		const runSpy = vi.fn();

		const ctx = makePhaseContext({
			runtime: { run: runSpy },
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(completedRecord),
				create: vi.fn(),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
		});

		const result = await runExecutePhase(ctx);

		expect(runSpy).not.toHaveBeenCalled();
		expect(result.status).toBe("completed");
	});

	// ---------------------------------------------------------------------------
	// Previously-failed slice halts execution
	// ---------------------------------------------------------------------------

	it("returns failed immediately when a slice has status failed", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);

		const failedRecord = makeSliceRecord({
			id: "slice-0",
			index: 0,
			name: "Foundation",
			status: "failed",
			error: "previous error",
		});
		const runSpy = vi.fn();

		const ctx = makePhaseContext({
			runtime: { run: runSpy },
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(failedRecord),
				create: vi.fn(),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
		});

		const result = await runExecutePhase(ctx);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("previously failed");
		expect(result.error).toContain("previous error");
		expect(runSpy).not.toHaveBeenCalled();
	});

	// ---------------------------------------------------------------------------
	// Agent run failure
	// ---------------------------------------------------------------------------

	it("marks slice failed and returns failed result when agent run fails", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const updateSpy = vi
			.fn()
			.mockImplementation((_id, updates) => ({ ...sliceRecord, ...updates }));
		const events: unknown[] = [];

		const ctx = makePhaseContext({
			runtime: {
				run: vi.fn().mockResolvedValue({
					success: false,
					output: "agent aborted",
					sessionId: "sess-fail",
					costUsd: 0.2,
					durationMs: 600,
					error: "agent aborted",
				} satisfies AgentRunResult),
			},
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: updateSpy,
				listByRun: vi.fn().mockReturnValue([]),
			},
			onEvent: (e) => events.push(e),
		});

		const result = await runExecutePhase(ctx);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("agent aborted");
		expect(updateSpy).toHaveBeenCalledWith(
			"slice-1",
			expect.objectContaining({ status: "failed", error: "agent aborted" }),
		);
		expect(events).toContainEqual(expect.objectContaining({ type: "slice_failed", sliceIndex: 0 }));
	});

	// ---------------------------------------------------------------------------
	// Worktree create failure
	// ---------------------------------------------------------------------------

	it("marks slice failed and returns failed result when worktree creation fails", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const updateSpy = vi.fn();
		const removeSpy = vi.fn();

		const ctx = makePhaseContext({
			worktree: {
				create: vi.fn().mockRejectedValue(new Error("git branch already exists")),
				remove: removeSpy,
			},
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: updateSpy,
				listByRun: vi.fn().mockReturnValue([]),
			},
		});

		const result = await runExecutePhase(ctx);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("Failed to create worktree");
		expect(updateSpy).toHaveBeenCalledWith(
			"slice-1",
			expect.objectContaining({ status: "failed" }),
		);
		// Worktree was never created so remove should not be called
		expect(removeSpy).not.toHaveBeenCalled();
	});

	// ---------------------------------------------------------------------------
	// Track file not found
	// ---------------------------------------------------------------------------

	it("marks slice failed when track file is missing", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		// No matching track file
		mockReaddir.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof readdir>>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const updateSpy = vi.fn();

		const ctx = makePhaseContext({
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: updateSpy,
				listByRun: vi.fn().mockReturnValue([]),
			},
		});

		const result = await runExecutePhase(ctx);

		expect(result.status).toBe("failed");
		expect(result.error).toContain("Track file for slice 0");
		expect(updateSpy).toHaveBeenCalledWith(
			"slice-1",
			expect.objectContaining({ status: "failed" }),
		);
	});

	// ---------------------------------------------------------------------------
	// PROGRESS.md sync failure is non-fatal
	// ---------------------------------------------------------------------------

	it("returns completed even when PROGRESS.md sync fails", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);
		mockCopyFile.mockRejectedValue(new Error("ENOENT: no such file"));

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });

		const ctx = makePhaseContext({
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
		});

		const result = await runExecutePhase(ctx);

		expect(result.status).toBe("completed");
	});

	// ---------------------------------------------------------------------------
	// Crash recovery — running slices reset to pending
	// ---------------------------------------------------------------------------

	it("resets running slices to pending before executing", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		// Slice appears as "running" (crashed run) in listByRun but "pending" when fetched per index
		const runningRecord = makeSliceRecord({
			id: "slice-1",
			index: 0,
			name: "Foundation",
			status: "running",
		});
		const pendingRecord = { ...runningRecord, status: "pending" as const };
		const updateSpy = vi.fn().mockImplementation((_id, updates) => ({
			...runningRecord,
			...updates,
		}));

		const ctx = makePhaseContext({
			stateSlices: {
				// getByIndex returns the (now-reset) pending record
				getByIndex: vi.fn().mockReturnValue(pendingRecord),
				create: vi.fn(),
				update: updateSpy,
				listByRun: vi.fn().mockReturnValue([runningRecord]),
			},
		});

		await runExecutePhase(ctx);

		// The running record should have been reset to pending during seeding
		expect(updateSpy).toHaveBeenCalledWith(
			"slice-1",
			expect.objectContaining({ status: "pending" }),
		);
	});

	// ---------------------------------------------------------------------------
	// workingBranch not set when no slices were executed
	// ---------------------------------------------------------------------------

	it("does not update workingBranch when all slices were already completed (skipped)", async () => {
		// All slices already completed — nothing to run so runs.update is never called
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);

		const completedRecord = makeSliceRecord({
			id: "slice-0",
			index: 0,
			name: "Foundation",
			status: "completed",
			costUsd: 0.5,
			durationMs: 1000,
		});
		const runsUpdateSpy = vi.fn();

		const ctx = makePhaseContext({
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(completedRecord),
				create: vi.fn(),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
			stateRuns: { update: runsUpdateSpy },
		});

		await runExecutePhase(ctx);

		// workingBranch is updated per-slice when agent runs; skipped completed slices do not call runs.update
		expect(runsUpdateSpy).not.toHaveBeenCalled();
	});

	// ---------------------------------------------------------------------------
	// Prompt building uses slice-execution template with all fields
	// ---------------------------------------------------------------------------

	it("calls buildPrompt with preReadContent and worktreeBoundary instead of files", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Base files created.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const buildPromptSpy = vi.fn().mockResolvedValue({
			phase: "slice-execution",
			layers: { system: "sys", context: "ctx", task: "tsk" },
			composedPrompt: "",
		});

		const ctx = makePhaseContext({
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
			prompts: { buildPrompt: buildPromptSpy },
		});

		await runExecutePhase(ctx);

		expect(buildPromptSpy).toHaveBeenCalledWith(
			"slice-execution",
			expect.objectContaining({
				slug: "demo-slug",
				runId: "run-1",
				includeContext: true,
				preReadContent: expect.objectContaining({
					planDoc: expect.any(String),
					progressDoc: expect.any(String),
					trackDoc: expect.any(String),
				}),
				worktreeBoundary: expect.objectContaining({
					worktreePath: "/fake/worktree",
					planDocPath: "implementations/demo-slug/demo-slug.md",
					progressDocPath: "implementations/demo-slug/PROGRESS.md",
					trackDocPath: expect.stringContaining("00-foundation.md"),
				}),
				slice: expect.objectContaining({
					index: 0,
					name: "Foundation",
					dod: "- Base files created.",
				}),
			}),
		);
	});

	it("passes baseBranch from workingBranch (resume) to worktree.create for second slice", async () => {
		const twoPlan = `
### Slice 00 - Foundation
Definition of Done:
- Done.

### Slice 01 - Scaffold
Definition of Done:
- Done.
`.trim();

		mockReadFile.mockResolvedValue(twoPlan);
		mockReaddir.mockResolvedValue(["00-foundation.md", "01-scaffold.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const completedRecord = makeSliceRecord({
			id: "slice-0",
			index: 0,
			name: "Foundation",
			status: "completed",
			costUsd: 0.5,
			durationMs: 1000,
		});
		const pendingRecord = makeSliceRecord({ id: "slice-1", index: 1, name: "Scaffold" });
		const createSpy = vi.fn().mockResolvedValue("/fake/worktree");

		const ctx = makePhaseContext({
			worktree: { create: createSpy },
			stateSlices: {
				getByIndex: vi
					.fn()
					.mockImplementation((_runId: string, index: number) =>
						index === 0 ? completedRecord : pendingRecord,
					),
				create: vi.fn(),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
		});

		await runExecutePhase(ctx);

		// Slice 01 should branch from task/demo-slug-0 (the completed slice 0 branch)
		expect(createSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				sliceIndex: 1,
				baseBranch: "task/demo-slug-0",
			}),
		);
	});

	it("uses baseBranch (main) for the first slice when no workingBranch is set", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const createSpy = vi.fn().mockResolvedValue("/fake/worktree");

		const ctx = makePhaseContext({
			worktree: { create: createSpy },
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
		});

		await runExecutePhase(ctx);

		expect(createSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				sliceIndex: 0,
				baseBranch: "main",
			}),
		);
	});

	// ---------------------------------------------------------------------------
	// Turn tracking
	// ---------------------------------------------------------------------------

	it("persists turnsUsed to slice record on success", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const sliceUpdateSpy = vi.fn();

		const ctx = makePhaseContext({
			runtime: {
				run: vi.fn().mockImplementation((options: { onProgress?: (e: unknown) => void }) => {
					options.onProgress?.({ type: "turn_complete", turnNumber: 1 });
					options.onProgress?.({ type: "turn_complete", turnNumber: 2 });
					options.onProgress?.({ type: "turn_complete", turnNumber: 3 });
					return Promise.resolve(makeSuccessResult());
				}),
			},
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: sliceUpdateSpy,
				listByRun: vi.fn().mockReturnValue([]),
			},
		});

		await runExecutePhase(ctx);

		const completedUpdate = sliceUpdateSpy.mock.calls.find(
			(call: unknown[]) => (call[1] as { status?: string })?.status === "completed",
		);
		expect(completedUpdate).toBeDefined();
		expect(completedUpdate?.[1]).toMatchObject({ turnsUsed: 3 });
	});

	it("persists turnsUsed to slice record on failure", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const sliceUpdateSpy = vi.fn();

		const ctx = makePhaseContext({
			runtime: {
				run: vi.fn().mockImplementation((options: { onProgress?: (e: unknown) => void }) => {
					options.onProgress?.({ type: "turn_complete", turnNumber: 1 });
					options.onProgress?.({ type: "turn_complete", turnNumber: 2 });
					return Promise.resolve({
						success: false,
						output: "error",
						sessionId: "sess-fail",
						costUsd: 0.1,
						durationMs: 500,
						error: "agent failed",
					} satisfies AgentRunResult);
				}),
			},
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: sliceUpdateSpy,
				listByRun: vi.fn().mockReturnValue([]),
			},
		});

		await runExecutePhase(ctx);

		const failedUpdate = sliceUpdateSpy.mock.calls.find(
			(call: unknown[]) => (call[1] as { status?: string })?.status === "failed",
		);
		expect(failedUpdate).toBeDefined();
		expect(failedUpdate?.[1]).toMatchObject({ turnsUsed: 2 });
	});

	it("emits slice_turn_warning when turns exceed 80% of maxTurnsPerSlice", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const events: unknown[] = [];

		// With maxTurnsPerSlice=10, warning threshold is 8 (floor(10*0.8))
		const ctx = makePhaseContext({
			runtime: {
				run: vi.fn().mockImplementation((options: { onProgress?: (e: unknown) => void }) => {
					for (let t = 1; t <= 10; t++) {
						options.onProgress?.({ type: "turn_complete", turnNumber: t });
					}
					return Promise.resolve(makeSuccessResult());
				}),
			},
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
			onEvent: (e) => events.push(e),
		});
		ctx.config = {
			...ctx.config,
			execution: { maxTurnsPerSlice: 10, maxTurnsPerReview: 20 },
		} as unknown as typeof ctx.config;

		await runExecutePhase(ctx);

		const warnings = events.filter((e) => (e as { type: string }).type === "slice_turn_warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({
			type: "slice_turn_warning",
			sliceIndex: 0,
			turnNumber: 9,
			maxTurns: 10,
		});
	});

	it("emits turn warning only once even when multiple turns exceed threshold", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const events: unknown[] = [];

		const ctx = makePhaseContext({
			runtime: {
				run: vi.fn().mockImplementation((options: { onProgress?: (e: unknown) => void }) => {
					// 5 turns all above threshold (threshold = floor(4*0.8) = 3)
					for (let t = 4; t <= 8; t++) {
						options.onProgress?.({ type: "turn_complete", turnNumber: t });
					}
					return Promise.resolve(makeSuccessResult());
				}),
			},
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
			onEvent: (e) => events.push(e),
		});
		ctx.config = {
			...ctx.config,
			execution: { maxTurnsPerSlice: 4, maxTurnsPerReview: 20 },
		} as unknown as typeof ctx.config;

		await runExecutePhase(ctx);

		const warnings = events.filter((e) => (e as { type: string }).type === "slice_turn_warning");
		expect(warnings).toHaveLength(1);
	});

	it("updates workingBranch per-slice immediately after success", async () => {
		const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);

		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const runsUpdateSpy = vi.fn();

		const ctx = makePhaseContext({
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
			stateRuns: { update: runsUpdateSpy },
		});

		await runExecutePhase(ctx);

		expect(runsUpdateSpy).toHaveBeenCalledWith(
			"run-1",
			expect.objectContaining({ workingBranch: "task/demo-slug-0" }),
		);
	});

	describe("gated slice execution", () => {
		it("requests slice approval in gated mode and emits approval events", async () => {
			const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
			mockReadFile.mockResolvedValue(singleSlicePlan);
			mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
				ReturnType<typeof readdir>
			>);

			const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
			const events: OrchestratorEvent[] = [];
			const requestApproval = vi.fn().mockResolvedValue({
				decision: "approved",
				feedback: null,
				respondedAt: new Date().toISOString(),
				channel: "tui",
			});

			const ctx = makePhaseContext({
				sliceExecution: "gated",
				messaging: { requestApproval },
				stateSlices: {
					getByIndex: vi.fn().mockReturnValue(sliceRecord),
					create: vi.fn().mockReturnValue(sliceRecord),
					update: vi.fn(),
					listByRun: vi.fn().mockReturnValue([]),
				},
				stateRuns: { update: vi.fn() },
				onEvent: (event) => events.push(event),
			});

			const result = await runExecutePhase(ctx);
			expect(result.status).toBe("completed");
			expect(requestApproval).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "execute",
					approvalType: "slice",
					sliceIndex: 0,
					sliceName: "Foundation",
				}),
			);
			expect(events.some((event) => event.type === "slice_approval_requested")).toBe(true);
			expect(events.some((event) => event.type === "slice_approval_resolved")).toBe(true);
			expect(vi.mocked(ctx.state.runs.update)).toHaveBeenCalledWith(
				"run-1",
				expect.objectContaining({ status: "awaiting_approval" }),
			);
		});

		it("runs a new same-worktree agent pass when approval returns request_changes", async () => {
			const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
			mockReadFile.mockResolvedValue(singleSlicePlan);
			mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
				ReturnType<typeof readdir>
			>);

			const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
			const runtimeRun = vi
				.fn()
				.mockResolvedValueOnce(makeSuccessResult({ sessionId: "sess-initial" }))
				.mockResolvedValueOnce(makeSuccessResult({ sessionId: "sess-fix" }));
			const requestApproval = vi
				.fn()
				.mockResolvedValueOnce({
					decision: "request_changes",
					feedback: "Please add stricter validation tests.",
					respondedAt: new Date().toISOString(),
					channel: "tui",
				})
				.mockResolvedValueOnce({
					decision: "approved",
					feedback: null,
					respondedAt: new Date().toISOString(),
					channel: "tui",
				});

			const ctx = makePhaseContext({
				sliceExecution: "gated",
				reviewEnabled: false,
				runtime: { run: runtimeRun },
				messaging: { requestApproval },
				stateSlices: {
					getByIndex: vi.fn().mockReturnValue(sliceRecord),
					create: vi.fn().mockReturnValue(sliceRecord),
					update: vi.fn(),
					listByRun: vi.fn().mockReturnValue([]),
				},
				stateRuns: { update: vi.fn() },
			});

			const result = await runExecutePhase(ctx);
			expect(result.status).toBe("completed");
			expect(requestApproval).toHaveBeenCalledTimes(2);
			expect(runtimeRun).toHaveBeenCalledTimes(2);
			expect(runtimeRun.mock.calls[1]?.[0]?.cwd).toBe("/fake/worktree");
		});

		it("resumes awaiting_approval request_changes on existing branch and preserves feedback", async () => {
			const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
			mockReadFile.mockResolvedValue(singleSlicePlan);
			mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
				ReturnType<typeof readdir>
			>);

			let sliceRecord = makeSliceRecord({
				id: "slice-1",
				index: 0,
				name: "Foundation",
				status: "awaiting_approval",
				costUsd: 0.5,
				durationMs: 300,
			});
			const runtimeRun = vi.fn().mockResolvedValue(makeSuccessResult({ sessionId: "sess-fix" }));
			const requestApproval = vi
				.fn()
				.mockResolvedValueOnce({
					decision: "request_changes",
					feedback: "Please add stricter validation tests.",
					respondedAt: new Date().toISOString(),
					channel: "tui",
				})
				.mockResolvedValueOnce({
					decision: "approved",
					feedback: null,
					respondedAt: new Date().toISOString(),
					channel: "tui",
				});
			const buildPromptSpy = vi.fn().mockResolvedValue({
				phase: "slice-fix",
				layers: { system: "sys", context: "ctx", task: "tsk" },
				composedPrompt: "",
			});
			const createSpy = vi.fn().mockResolvedValue("/fake/worktree");
			const updateSlice = vi
				.fn()
				.mockImplementation((_id: string, patch: Record<string, unknown>) => {
					sliceRecord = { ...sliceRecord, ...patch };
				});

			const ctx = makePhaseContext({
				sliceExecution: "gated",
				reviewEnabled: false,
				workingBranch: "task/demo-slug-0",
				runtime: { run: runtimeRun },
				worktree: { create: createSpy },
				prompts: { buildPrompt: buildPromptSpy },
				messaging: { requestApproval },
				stateSlices: {
					getByIndex: vi.fn().mockImplementation(() => sliceRecord),
					create: vi.fn().mockReturnValue(sliceRecord),
					update: updateSlice,
					listByRun: vi.fn().mockReturnValue([]),
				},
				stateRuns: { update: vi.fn() },
			});

			const result = await runExecutePhase(ctx);
			expect(result.status).toBe("completed");
			expect(requestApproval).toHaveBeenCalledTimes(2);
			expect(runtimeRun).toHaveBeenCalledTimes(1);
			expect(createSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					sliceIndex: 0,
					baseBranch: "task/demo-slug-0",
					reuseExistingBranch: true,
				}),
			);

			const promptPhases = buildPromptSpy.mock.calls.map(([phase]) => phase);
			expect(promptPhases).toContain("slice-fix");
			expect(promptPhases).not.toContain("slice-execution");
			expect(buildPromptSpy).toHaveBeenCalledWith(
				"slice-fix",
				expect.objectContaining({
					review: expect.objectContaining({
						findings: [
							expect.objectContaining({
								body: "Please add stricter validation tests.",
							}),
						],
					}),
				}),
			);
		});

		it("fails the phase when slice approval is rejected", async () => {
			const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
			mockReadFile.mockResolvedValue(singleSlicePlan);
			mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
				ReturnType<typeof readdir>
			>);

			const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
			const requestApproval = vi.fn().mockResolvedValue({
				decision: "rejected",
				feedback: "Do not proceed with this slice.",
				respondedAt: new Date().toISOString(),
				channel: "tui",
			});

			const ctx = makePhaseContext({
				sliceExecution: "gated",
				messaging: { requestApproval },
				stateSlices: {
					getByIndex: vi.fn().mockReturnValue(sliceRecord),
					create: vi.fn().mockReturnValue(sliceRecord),
					update: vi.fn(),
					listByRun: vi.fn().mockReturnValue([]),
				},
				stateRuns: { update: vi.fn() },
			});

			const result = await runExecutePhase(ctx);
			expect(result.status).toBe("failed");
			expect(result.error).toContain("Do not proceed with this slice.");
		});
	});
});

// =============================================================================
// parseReviewOutput
// =============================================================================

describe("parseReviewOutput", () => {
	it("parses a valid PASS verdict", () => {
		const output = JSON.stringify({
			verdict: "PASS",
			confidence: 0.95,
			summary: "All good",
			findings: [],
		});
		const result = parseReviewOutput(output);
		expect(result).toEqual({
			verdict: "PASS",
			confidence: 0.95,
			summary: "All good",
			findings: [],
		});
	});

	it("parses a valid FAIL verdict with findings", () => {
		const findings = [{ severity: "major", file: "src/foo.ts", title: "Bug", body: "desc" }];
		const output = JSON.stringify({
			verdict: "FAIL",
			confidence: 0.7,
			summary: "Found issues",
			findings,
		});
		const result = parseReviewOutput(output);
		expect(result?.verdict).toBe("FAIL");
		expect(result?.findings).toHaveLength(1);
	});

	it("parses a valid PARTIAL verdict", () => {
		const output = JSON.stringify({
			verdict: "PARTIAL",
			confidence: 0.6,
			summary: "Some issues",
			findings: [],
		});
		const result = parseReviewOutput(output);
		expect(result?.verdict).toBe("PARTIAL");
	});

	it("extracts JSON embedded in surrounding text", () => {
		const output = `Here is my review:\n${JSON.stringify({ verdict: "PASS", confidence: 1, summary: "ok", findings: [] })}\nEnd of review.`;
		const result = parseReviewOutput(output);
		expect(result?.verdict).toBe("PASS");
	});

	it("returns null for non-JSON output", () => {
		expect(parseReviewOutput("The code looks good overall.")).toBeNull();
	});

	it("returns null for JSON with invalid verdict", () => {
		const output = JSON.stringify({
			verdict: "UNKNOWN",
			confidence: 0.5,
			summary: "",
			findings: [],
		});
		expect(parseReviewOutput(output)).toBeNull();
	});

	it("returns null for malformed JSON", () => {
		expect(parseReviewOutput("{verdict: PASS}")).toBeNull();
	});

	it("defaults confidence to 0 and findings to [] when fields are missing", () => {
		const output = JSON.stringify({ verdict: "PASS" });
		const result = parseReviewOutput(output);
		expect(result?.confidence).toBe(0);
		expect(result?.findings).toEqual([]);
		expect(result?.summary).toBe("");
	});
});

// =============================================================================
// Review loop — runExecutePhase integration tests
// =============================================================================

describe("review loop", () => {
	const singleSlicePlan = "### Slice 00 - Foundation\nDefinition of Done:\n- Done.";
	const passOutput = JSON.stringify({
		verdict: "PASS",
		confidence: 0.95,
		summary: "Looks good",
		findings: [],
	});
	const failOutput = JSON.stringify({
		verdict: "FAIL",
		confidence: 0.7,
		summary: "Missing error handling",
		findings: [{ severity: "major", file: "src/foo.ts", title: "Bug", body: "desc" }],
	});
	const partialOutput = JSON.stringify({
		verdict: "PARTIAL",
		confidence: 0.5,
		summary: "Partial issues",
		findings: [{ severity: "minor", file: "src/bar.ts", title: "Nit", body: "desc" }],
	});

	beforeEach(() => {
		vi.clearAllMocks();
		mockReadFile.mockResolvedValue(singleSlicePlan);
		mockReaddir.mockResolvedValue(["00-foundation.md"] as unknown as Awaited<
			ReturnType<typeof readdir>
		>);
		mockCopyFile.mockResolvedValue(undefined);
	});

	function makeReviewCtx(opts: {
		runtimeResponses: AgentRunResult[];
		countBySliceResponses?: number[];
		onEvent?: PhaseContext["onEvent"];
	}): PhaseContext {
		let runtimeCallCount = 0;
		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });

		let countCall = 0;
		const countResponses = opts.countBySliceResponses ?? [0, 1];

		return makePhaseContext({
			reviewEnabled: true,
			runtime: {
				run: vi.fn().mockImplementation(() => {
					const result = opts.runtimeResponses[runtimeCallCount] ?? makeSuccessResult();
					runtimeCallCount++;
					return Promise.resolve(result);
				}),
			},
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
			stateReviews: {
				countBySlice: vi.fn().mockImplementation(() => {
					const val = countResponses[countCall] ?? countResponses[countResponses.length - 1];
					countCall++;
					return val;
				}),
				create: vi.fn().mockReturnValue({ id: "rev-1" }),
			},
			stateRuns: { update: vi.fn() },
			onEvent: opts.onEvent,
		});
	}

	it("skips review loop when review.enabled is false", async () => {
		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });
		const runtimeMock = vi.fn().mockResolvedValue(makeSuccessResult());

		const ctx = makePhaseContext({
			reviewEnabled: false,
			runtime: { run: runtimeMock },
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: vi.fn(),
				listByRun: vi.fn().mockReturnValue([]),
			},
			stateRuns: { update: vi.fn() },
		});

		const result = await runExecutePhase(ctx);
		expect(result.status).toBe("completed");
		// Only 1 runtime call (implementer) — no reviewer or fixer
		expect(runtimeMock).toHaveBeenCalledTimes(1);
	});

	it("marks slice completed when reviewer returns PASS on first iteration", async () => {
		const events: OrchestratorEvent[] = [];
		const ctx = makeReviewCtx({
			// call 0: implementer, call 1: reviewer → PASS
			runtimeResponses: [makeSuccessResult(), makeSuccessResult({ output: passOutput })],
			countBySliceResponses: [0], // countBySlice always returns 0 (pre-create)
			onEvent: (e) => events.push(e),
		});

		const result = await runExecutePhase(ctx);
		expect(result.status).toBe("completed");
		// reviewer called once, no fixer
		expect(ctx.runtime.run as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(2);
		expect(events.some((e) => e.type === "review_started")).toBe(true);
		expect(events.some((e) => e.type === "review_completed" && e.verdict === "PASS")).toBe(true);
		expect(events.some((e) => e.type === "slice_completed")).toBe(true);
	});

	it("runs fixer and re-reviews when reviewer returns FAIL and under cap", async () => {
		// countBySlice calls: [pre-review1=0, post-review1=1, pre-review2=1, post-review2=2]
		// but since we PASS on second review, escalation check at post-review1=1 < maxIterations(2) → fix
		const ctx = makeReviewCtx({
			// call 0: implementer, call 1: reviewer FAIL, call 2: fixer, call 3: reviewer PASS
			runtimeResponses: [
				makeSuccessResult(),
				makeSuccessResult({ output: failOutput }),
				makeSuccessResult({ output: "Fixed the issues." }),
				makeSuccessResult({ output: passOutput }),
			],
			// countBySlice returns: 0 (pre-review1 iteration calc), 1 (post-review1 cap check), 1 (pre-review2 iteration calc), 2 (post-review2 cap check - not reached since PASS)
			countBySliceResponses: [0, 1, 1, 2],
		});

		const result = await runExecutePhase(ctx);
		expect(result.status).toBe("completed");
		// implementer + reviewer(FAIL) + fixer + reviewer(PASS)
		expect(ctx.runtime.run as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(4);
		expect(ctx.state.reviews.create as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(2);
	});

	it("escalates and marks slice failed when reviewer returns FAIL at maxIterations", async () => {
		// maxIterations = 2, so after 2 FAILs we escalate
		const events: Parameters<NonNullable<PhaseContext["onEvent"]>>[0][] = [];
		const ctx = makeReviewCtx({
			// call 0: implementer, call 1: reviewer FAIL, call 2: fixer, call 3: reviewer FAIL → escalate
			runtimeResponses: [
				makeSuccessResult(),
				makeSuccessResult({ output: failOutput }),
				makeSuccessResult({ output: "Attempted fix." }),
				makeSuccessResult({ output: failOutput }),
			],
			// countBySlice: 0 (pre-review1 iter), 1 (post-review1 cap check: 1 < 2, continue), 1 (pre-review2 iter), 2 (post-review2 cap check: 2 >= 2, escalate)
			countBySliceResponses: [0, 1, 1, 2],
			onEvent: (e) => events.push(e),
		});

		const result = await runExecutePhase(ctx);
		expect(result.status).toBe("failed");
		expect(result.error).toContain("failed review after 2 iteration(s)");
		expect(events.some((e) => e.type === "review_escalated")).toBe(true);
		expect(events.some((e) => e.type === "slice_failed")).toBe(true);
	});

	it("treats PARTIAL verdict same as FAIL for fix loop triggering", async () => {
		const ctx = makeReviewCtx({
			// call 0: implementer, call 1: reviewer PARTIAL, call 2: fixer, call 3: reviewer PASS
			runtimeResponses: [
				makeSuccessResult(),
				makeSuccessResult({ output: partialOutput }),
				makeSuccessResult({ output: "Fixed partials." }),
				makeSuccessResult({ output: passOutput }),
			],
			countBySliceResponses: [0, 1, 1, 2],
		});

		const result = await runExecutePhase(ctx);
		expect(result.status).toBe("completed");
		expect(ctx.runtime.run as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(4);
	});

	it("treats unparse-able reviewer output as FAIL", async () => {
		// reviewer outputs garbage → treated as FAIL → escalate after maxIterations
		const ctx = makeReviewCtx({
			runtimeResponses: [
				makeSuccessResult(),
				makeSuccessResult({ output: "I cannot review this" }),
				makeSuccessResult({ output: "Fixed." }),
				makeSuccessResult({ output: "Still cannot review" }),
			],
			countBySliceResponses: [0, 1, 1, 2],
		});

		const result = await runExecutePhase(ctx);
		expect(result.status).toBe("failed");
	});

	it("emits review_started event at each iteration", async () => {
		const events: Parameters<NonNullable<PhaseContext["onEvent"]>>[0][] = [];
		const ctx = makeReviewCtx({
			runtimeResponses: [
				makeSuccessResult(),
				makeSuccessResult({ output: failOutput }),
				makeSuccessResult({ output: "fix" }),
				makeSuccessResult({ output: passOutput }),
			],
			countBySliceResponses: [0, 1, 1, 2],
			onEvent: (e) => events.push(e),
		});

		await runExecutePhase(ctx);

		const reviewStarted = events.filter((e) => e.type === "review_started");
		expect(reviewStarted).toHaveLength(2);
		expect(reviewStarted[0]).toMatchObject({ type: "review_started", iteration: 1 });
		expect(reviewStarted[1]).toMatchObject({ type: "review_started", iteration: 2 });
	});

	it("combines review costs into slice record on PASS", async () => {
		const slicesUpdateSpy = vi.fn();
		const sliceRecord = makeSliceRecord({ id: "slice-1", index: 0, name: "Foundation" });

		const ctx = makePhaseContext({
			reviewEnabled: true,
			runtime: {
				run: vi
					.fn()
					.mockResolvedValueOnce(makeSuccessResult({ costUsd: 1.0, durationMs: 1000 })) // implementer
					.mockResolvedValueOnce(
						makeSuccessResult({ output: passOutput, costUsd: 0.2, durationMs: 200 }),
					), // reviewer
			},
			stateSlices: {
				getByIndex: vi.fn().mockReturnValue(sliceRecord),
				create: vi.fn().mockReturnValue(sliceRecord),
				update: slicesUpdateSpy,
				listByRun: vi.fn().mockReturnValue([]),
			},
			stateReviews: {
				countBySlice: vi.fn().mockReturnValue(0),
				create: vi.fn().mockReturnValue({ id: "rev-1" }),
			},
			stateRuns: { update: vi.fn() },
		});

		await runExecutePhase(ctx);

		// The completed update should combine costs
		const completedCall = slicesUpdateSpy.mock.calls.find(
			([, update]) => update.status === "completed",
		);
		expect(completedCall?.[1]).toMatchObject({
			status: "completed",
			costUsd: 1.2,
			durationMs: 1200,
		});
	});
});
