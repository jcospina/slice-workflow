import { copyFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	type SliceExecutionContext,
	buildSliceExecutionContext,
} from "../../runtime/slice-context";
import type { AgentRunResult } from "../../runtime/types";
import type { SliceRecord } from "../../state/types";
import type { PhaseContext, PhaseResult } from "./types";

// --- Constants ---

const CLAUDE_AUTONOMOUS_ALLOWED_TOOLS = [
	"Read",
	"Write",
	"Edit",
	"MultiEdit",
	"Glob",
	"Grep",
	"LS",
	"Bash(*)",
	"WebSearch",
	"WebFetch",
];

// --- Types ---

interface SliceDefinition {
	index: number;
	name: string;
	dod: string;
}

// --- Helpers ---

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function makeFailedResult(
	error: string,
	details?: { agentSessionId?: string | null; costUsd?: number; durationMs?: number },
): PhaseResult {
	return {
		status: "failed",
		agentSessionId: details?.agentSessionId ?? null,
		costUsd: details?.costUsd ?? null,
		durationMs: details?.durationMs ?? null,
		error,
		output: null,
	};
}

function getAllowedToolsForRuntime(
	provider: PhaseContext["runtime"]["provider"],
): string[] | undefined {
	if (provider === "claude-code") {
		return CLAUDE_AUTONOMOUS_ALLOWED_TOOLS;
	}
	return undefined;
}

// --- Plan document parser ---

/**
 * Parses `### Slice NN - Name` sections from a plan document and extracts
 * each slice's numeric index, display name, and Definition of Done text.
 *
 * Pure function — no I/O.
 */
export function parsePlanSlices(content: string): SliceDefinition[] {
	const headerMatches = [...content.matchAll(/^### Slice (\d+) - (.+)$/gm)].map((m) => ({
		index: Number.parseInt(m[1], 10),
		name: m[2].trim(),
		contentStart: m.index + m[0].length,
		pos: m.index,
	}));

	return headerMatches.map((match, i) => {
		const sectionEnd = i + 1 < headerMatches.length ? headerMatches[i + 1].pos : content.length;
		const sectionBody = content.slice(match.contentStart, sectionEnd);

		const dodMarker = "Definition of Done:";
		const dodPos = sectionBody.indexOf(dodMarker);
		const dod = dodPos >= 0 ? sectionBody.slice(dodPos + dodMarker.length).trim() : "";

		return { index: match.index, name: match.name, dod };
	});
}

// --- Track file resolver ---

/**
 * Finds the track file for a given slice index.
 * Track files follow the naming pattern `NN-*.md` (zero-padded index prefix).
 * Returns the absolute path to the first matching file, or null if not found.
 */
export async function findTrackFile(tracksDir: string, sliceIndex: number): Promise<string | null> {
	const prefix = `${String(sliceIndex).padStart(2, "0")}-`;
	try {
		const entries = await readdir(tracksDir);
		const match = entries.find((f) => f.startsWith(prefix) && f.endsWith(".md"));
		return match ? join(tracksDir, match) : null;
	} catch {
		return null;
	}
}

// --- Idempotent slice seeding ---

/**
 * Creates pending slice records in SQLite for any slice not yet registered.
 * Idempotent: skips slices that already have a record.
 * Resets any "running" slices to "pending" to handle crash recovery.
 */
function seedSliceRecords(ctx: PhaseContext, sliceDefs: SliceDefinition[]): void {
	for (const def of sliceDefs) {
		const existing = ctx.state.slices.getByIndex(ctx.runId, def.index);
		if (!existing) {
			ctx.state.slices.create({
				runId: ctx.runId,
				index: def.index,
				name: def.name,
				status: "pending",
				agentSessionId: null,
				costUsd: null,
				durationMs: null,
				error: null,
				startedAt: null,
				endedAt: null,
			});
		}
	}

	// Reset any slices left in "running" state from a previous crashed run.
	for (const record of ctx.state.slices.listByRun(ctx.runId)) {
		if (record.status === "running") {
			ctx.state.slices.update(record.id, { status: "pending", error: null });
		}
	}
}

// --- PROGRESS.md sync ---

/**
 * Copies the updated PROGRESS.md from the worktree back to the main
 * implementations directory so the next slice sees the latest state.
 *
 * Non-fatal: callers catch errors and continue.
 */
async function syncProgressFromWorktree(
	worktreePath: string,
	implRelDir: string,
	implementationsDir: string,
	slug: string,
): Promise<void> {
	const src = join(worktreePath, implRelDir, slug, "PROGRESS.md");
	const dest = join(implementationsDir, slug, "PROGRESS.md");
	await copyFile(src, dest);
}

// --- Prompt builder ---

async function buildSlicePrompts(
	ctx: PhaseContext,
	def: SliceDefinition,
	sliceCtx: SliceExecutionContext,
): Promise<{ systemPrompt: string; prompt: string }> {
	const built = await ctx.prompts.buildPrompt("slice-execution", {
		slug: ctx.run.slug,
		runId: ctx.runId,
		taskDescription: ctx.run.taskDescription,
		topLevelPhase: ctx.phase,
		preReadContent: {
			planDoc: sliceCtx.planDoc,
			progressDoc: sliceCtx.progressDoc,
			trackDoc: sliceCtx.trackDoc,
		},
		worktreeBoundary: {
			worktreePath: sliceCtx.worktreePath,
			planDocPath: sliceCtx.planDocPath,
			progressDocPath: sliceCtx.progressDocPath,
			trackDocPath: sliceCtx.trackDocPath,
		},
		slice: { index: def.index, name: def.name, dod: def.dod },
		includeContext: true,
	});

	const prompt = [built.layers.context, built.layers.task].filter(Boolean).join("\n\n");

	return { systemPrompt: built.layers.system, prompt };
}

// --- Single slice execution ---

interface SliceOutcome {
	/** Populated when the slice fails; callers propagate this as the phase result. */
	failure?: PhaseResult;
	costUsd: number;
	durationMs: number;
}

/**
 * Applies the agent run result to state and PROGRESS.md sync.
 */
async function applyRunResult(
	ctx: PhaseContext,
	def: SliceDefinition,
	record: SliceRecord,
	runResult: AgentRunResult,
	worktreePath: string,
): Promise<SliceOutcome> {
	const endedAt = new Date().toISOString();

	if (!runResult.success) {
		const msg = runResult.error ?? runResult.output ?? `Slice ${def.index} agent run failed.`;
		ctx.state.slices.update(record.id, {
			status: "failed",
			agentSessionId: runResult.sessionId,
			costUsd: runResult.costUsd,
			durationMs: runResult.durationMs,
			error: msg,
			endedAt,
		});
		ctx.onEvent?.({ type: "slice_failed", runId: ctx.runId, sliceIndex: def.index, error: msg });
		return {
			failure: makeFailedResult(msg, {
				agentSessionId: runResult.sessionId,
				costUsd: runResult.costUsd,
				durationMs: runResult.durationMs,
			}),
			costUsd: runResult.costUsd ?? 0,
			durationMs: runResult.durationMs ?? 0,
		};
	}

	ctx.state.slices.update(record.id, {
		status: "completed",
		agentSessionId: runResult.sessionId,
		costUsd: runResult.costUsd,
		durationMs: runResult.durationMs,
		endedAt,
	});
	ctx.onEvent?.({
		type: "slice_completed",
		runId: ctx.runId,
		sliceIndex: def.index,
		costUsd: runResult.costUsd,
	});

	// Sync PROGRESS.md from the worktree back to the main implementations dir.
	// Non-fatal: the agent may not have committed changes yet.
	try {
		await syncProgressFromWorktree(
			worktreePath,
			ctx.config.implementationsDir,
			ctx.implementationsDir,
			ctx.run.slug,
		);
	} catch {
		// Intentionally swallowed — sync failure does not abort the run.
	}

	return { costUsd: runResult.costUsd ?? 0, durationMs: runResult.durationMs ?? 0 };
}

/**
 * Runs the agent inside the worktree after it has been created and set up.
 */
async function runSliceInWorktree(
	ctx: PhaseContext,
	def: SliceDefinition,
	record: SliceRecord,
	paths: { planPath: string; progressPath: string; trackPath: string },
	worktreePath: string,
): Promise<SliceOutcome> {
	await ctx.worktree.setup(worktreePath);

	let sliceCtx: SliceExecutionContext;
	try {
		const costSummary = ctx.state.getRunCostSummary(ctx.runId);
		sliceCtx = await buildSliceExecutionContext({
			planPath: paths.planPath,
			progressPath: paths.progressPath,
			trackPath: paths.trackPath,
			implRelDir: ctx.config.implementationsDir,
			slug: ctx.run.slug,
			worktreePath,
			cumulativeCostUsd: costSummary.totalCostUsd,
			remainingBudgetUsd: null,
			slice: { index: def.index, name: def.name },
		});
	} catch (error) {
		const msg = `Failed to build slice context for slice ${def.index} (${def.name}): ${toErrorMessage(error)}`;
		ctx.state.slices.update(record.id, {
			status: "failed",
			error: msg,
			endedAt: new Date().toISOString(),
		});
		ctx.onEvent?.({ type: "slice_failed", runId: ctx.runId, sliceIndex: def.index, error: msg });
		return { failure: makeFailedResult(msg), costUsd: 0, durationMs: 0 };
	}

	let prompts: { systemPrompt: string; prompt: string };
	try {
		prompts = await buildSlicePrompts(ctx, def, sliceCtx);
	} catch (error) {
		const msg = `Failed to build prompt for slice ${def.index} (${def.name}): ${toErrorMessage(error)}`;
		ctx.state.slices.update(record.id, {
			status: "failed",
			error: msg,
			endedAt: new Date().toISOString(),
		});
		ctx.onEvent?.({ type: "slice_failed", runId: ctx.runId, sliceIndex: def.index, error: msg });
		return { failure: makeFailedResult(msg), costUsd: 0, durationMs: 0 };
	}

	const runResult = await ctx.runtime.run({
		cwd: worktreePath,
		systemPrompt: prompts.systemPrompt,
		prompt: prompts.prompt,
		allowedTools: getAllowedToolsForRuntime(ctx.runtime.provider),
		onProgress: () => {
			// Phase-local. Top-level orchestrator events do not currently include a
			// progress event contract for slice agents.
		},
	});

	return applyRunResult(ctx, def, record, runResult, worktreePath);
}

/**
 * Executes one slice end-to-end:
 *   create worktree → setup → build prompts → run agent → mark result → sync PROGRESS.md → cleanup.
 *
 * Returns a `failure` result when the slice cannot be completed. The worktree
 * is always removed in a `finally` block regardless of outcome.
 */
async function runSingleSlice(
	ctx: PhaseContext,
	def: SliceDefinition,
	record: SliceRecord,
	paths: { planPath: string; progressPath: string; tracksDir: string },
	baseBranch: string,
): Promise<SliceOutcome> {
	// Locate track file before creating the worktree so we fail fast without
	// leaving a stale worktree behind.
	const trackPath = await findTrackFile(paths.tracksDir, def.index);
	if (!trackPath) {
		const error = `Track file for slice ${def.index} (${def.name}) not found in '${paths.tracksDir}'. Expected a file matching '${String(def.index).padStart(2, "0")}-*.md'.`;
		ctx.state.slices.update(record.id, {
			status: "failed",
			error,
			endedAt: new Date().toISOString(),
		});
		ctx.onEvent?.({ type: "slice_failed", runId: ctx.runId, sliceIndex: def.index, error });
		return { failure: makeFailedResult(error), costUsd: 0, durationMs: 0 };
	}

	let worktreePath: string;
	try {
		worktreePath = await ctx.worktree.create({
			runId: ctx.runId,
			slug: ctx.run.slug,
			sliceIndex: def.index,
			baseBranch,
		});
	} catch (error) {
		const msg = `Failed to create worktree for slice ${def.index} (${def.name}): ${toErrorMessage(error)}`;
		ctx.state.slices.update(record.id, {
			status: "failed",
			error: msg,
			endedAt: new Date().toISOString(),
		});
		ctx.onEvent?.({ type: "slice_failed", runId: ctx.runId, sliceIndex: def.index, error: msg });
		return { failure: makeFailedResult(msg), costUsd: 0, durationMs: 0 };
	}

	try {
		return await runSliceInWorktree(ctx, def, record, { ...paths, trackPath }, worktreePath);
	} finally {
		try {
			await ctx.worktree.remove(worktreePath);
		} catch {
			// Non-fatal: stale worktrees can be cleaned up with `slice worktree prune`.
		}
	}
}

// --- Sequential slice loop ---

interface SliceLoopResult {
	failure?: PhaseResult;
	costUsd: number;
	durationMs: number;
	lastExecutedIndex: number;
}

async function executeSlicesSequentially(
	ctx: PhaseContext,
	sliceDefs: SliceDefinition[],
	paths: { planPath: string; progressPath: string; tracksDir: string },
): Promise<SliceLoopResult> {
	const slug = ctx.run.slug;
	let totalCostUsd = 0;
	let totalDurationMs = 0;
	let lastExecutedIndex = -1;
	// Start from workingBranch (resume case) or baseBranch (fresh run).
	let currentBranch = ctx.run.workingBranch ?? ctx.run.baseBranch;

	for (const def of sliceDefs) {
		const record = ctx.state.slices.getByIndex(ctx.runId, def.index);
		if (!record) {
			continue;
		}

		if (record.status === "completed") {
			totalCostUsd += record.costUsd ?? 0;
			totalDurationMs += record.durationMs ?? 0;
			lastExecutedIndex = def.index;
			// Advance currentBranch so the next pending slice branches from the right place.
			currentBranch = `task/${slug}-${def.index}`;
			continue;
		}

		if (record.status === "failed") {
			const failure = makeFailedResult(
				`Slice ${def.index} (${def.name}) previously failed: ${record.error ?? "unknown error"}. Resolve the issue before retrying.`,
				{ costUsd: totalCostUsd, durationMs: totalDurationMs },
			);
			return { failure, costUsd: totalCostUsd, durationMs: totalDurationMs, lastExecutedIndex };
		}

		ctx.state.slices.update(record.id, {
			status: "running",
			startedAt: new Date().toISOString(),
		});
		ctx.onEvent?.({
			type: "slice_started",
			runId: ctx.runId,
			sliceIndex: def.index,
			sliceName: def.name,
		});

		const outcome = await runSingleSlice(ctx, def, record, paths, currentBranch);

		if (outcome.failure) {
			const failure = {
				...outcome.failure,
				costUsd: (outcome.failure.costUsd ?? 0) + totalCostUsd,
				durationMs: (outcome.failure.durationMs ?? 0) + totalDurationMs,
			};
			return { failure, costUsd: totalCostUsd, durationMs: totalDurationMs, lastExecutedIndex };
		}

		totalCostUsd += outcome.costUsd;
		totalDurationMs += outcome.durationMs;
		lastExecutedIndex = def.index;
		// Update currentBranch and persist per-slice so resume picks up from the right place.
		currentBranch = `task/${slug}-${def.index}`;
		ctx.state.runs.update(ctx.runId, { workingBranch: currentBranch });
	}

	return { costUsd: totalCostUsd, durationMs: totalDurationMs, lastExecutedIndex };
}

// --- Main phase handler ---

/**
 * Runs the sequential slice execution phase:
 *   1. Reads and parses the plan document to discover slice definitions.
 *   2. Seeds SQLite with pending slice records (idempotent for resume).
 *   3. Iterates slices in order: creates an isolated worktree, runs the
 *      implementer agent with exactly 3 context files, persists the result,
 *      syncs PROGRESS.md, and cleans up the worktree.
 *   4. Records the last completed slice branch as the working branch so the
 *      handoff phase knows where to create a PR from.
 */
export async function runExecutePhase(ctx: PhaseContext): Promise<PhaseResult> {
	const slug = ctx.run.slug;
	const implementationsDir = ctx.implementationsDir;
	const planPath = join(implementationsDir, slug, `${slug}.md`);
	const progressPath = join(implementationsDir, slug, "PROGRESS.md");
	const tracksDir = join(implementationsDir, slug, "tracks");

	let planContent: string;
	try {
		planContent = await readFile(planPath, "utf-8");
	} catch (error) {
		return makeFailedResult(
			`Execute phase requires a plan document at '${planPath}', but it could not be read: ${toErrorMessage(error)}`,
		);
	}

	const sliceDefs = parsePlanSlices(planContent);
	if (sliceDefs.length === 0) {
		return makeFailedResult(
			`No slice definitions found in plan document at '${planPath}'. Ensure the plan has slice headers matching '### Slice NN - Name'.`,
		);
	}

	seedSliceRecords(ctx, sliceDefs);

	const loop = await executeSlicesSequentially(ctx, sliceDefs, {
		planPath,
		progressPath,
		tracksDir,
	});

	if (loop.failure) {
		return loop.failure;
	}

	return {
		status: "completed",
		agentSessionId: null,
		costUsd: loop.costUsd,
		durationMs: loop.durationMs,
		error: null,
		output: planPath,
	};
}
