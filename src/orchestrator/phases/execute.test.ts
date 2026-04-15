import { copyFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunResult } from "../../runtime/types";
import type { SliceRecord, WorkflowRun } from "../../state/types";
import { findTrackFile, parsePlanSlices, runExecutePhase } from "./execute";
import type { PhaseContext } from "./types";

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
	prompts?: Partial<PhaseContext["prompts"]>;
	onEvent?: PhaseContext["onEvent"];
	workingBranch?: string | null;
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
		} as PhaseContext["config"],
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
		messaging: {} as PhaseContext["messaging"],
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
});
