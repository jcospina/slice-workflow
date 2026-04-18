import type { SliceRecord } from "../../../state/types";
import type { PhaseContext } from "../types";
import { buildSliceBranchName, makeFailedResult } from "./common";
import { findTrackFile } from "./parsers";
import { requestSliceApproval, resumeSliceFromRequestChanges, runSingleSlice } from "./slice";
import type { ExecuteArtifactsPaths, SliceDefinition, SliceLoopResult } from "./types";

type SliceStepResult =
	| { done: false; costUsd: number; durationMs: number; branch: string }
	| { done: true; loopResult: SliceLoopResult };

/**
 * Run-level sequential orchestration for execute phase.
 * Owns resume behavior and per-slice branch progression.
 */
export function seedSliceRecords(ctx: PhaseContext, sliceDefs: SliceDefinition[]): void {
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
				turnsUsed: null,
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

async function processAwaitingApprovalSlice(
	ctx: PhaseContext,
	def: SliceDefinition,
	record: SliceRecord,
	paths: ExecuteArtifactsPaths,
	slug: string,
	totalCostUsd: number,
	totalDurationMs: number,
	lastExecutedIndex: number,
): Promise<SliceStepResult> {
	const trackPath = await findTrackFile(paths.tracksDir, def.index);
	if (!trackPath) {
		const error = `Track file for slice ${def.index} (${def.name}) not found in '${paths.tracksDir}'. Expected a file matching '${String(def.index).padStart(2, "0")}-*.md'.`;
		ctx.state.slices.update(record.id, {
			status: "failed",
			error,
			endedAt: new Date().toISOString(),
		});
		const failure = makeFailedResult(error, { costUsd: totalCostUsd, durationMs: totalDurationMs });
		return {
			done: true,
			loopResult: {
				failure,
				costUsd: totalCostUsd,
				durationMs: totalDurationMs,
				lastExecutedIndex,
			},
		};
	}

	const approval = await requestSliceApproval(ctx, def, record, trackPath);
	if (approval.failure) {
		const failure = {
			...approval.failure,
			costUsd: (approval.failure.costUsd ?? 0) + totalCostUsd,
			durationMs: (approval.failure.durationMs ?? 0) + totalDurationMs,
		};
		return {
			done: true,
			loopResult: {
				failure,
				costUsd: totalCostUsd,
				durationMs: totalDurationMs,
				lastExecutedIndex,
			},
		};
	}

	if (approval.decision === "approved") {
		const approvedRecord = ctx.state.slices.getByIndex(ctx.runId, def.index) ?? record;
		return {
			done: false,
			costUsd: approvedRecord.costUsd ?? 0,
			durationMs: approvedRecord.durationMs ?? 0,
			branch: buildSliceBranchName(slug, def.index),
		};
	}

	// Resume request_changes using the existing slice branch so feedback is preserved.
	const resumed = await resumeSliceFromRequestChanges(
		ctx,
		def,
		record,
		paths,
		approval.feedback ?? "",
	);
	if (resumed.failure) {
		const failure = {
			...resumed.failure,
			costUsd: (resumed.failure.costUsd ?? 0) + totalCostUsd,
			durationMs: (resumed.failure.durationMs ?? 0) + totalDurationMs,
		};
		return {
			done: true,
			loopResult: {
				failure,
				costUsd: totalCostUsd,
				durationMs: totalDurationMs,
				lastExecutedIndex,
			},
		};
	}

	const resumedRecord = ctx.state.slices.getByIndex(ctx.runId, def.index) ?? record;
	return {
		done: false,
		costUsd: resumedRecord.costUsd ?? 0,
		durationMs: resumedRecord.durationMs ?? 0,
		branch: buildSliceBranchName(slug, def.index),
	};
}

async function executeFreshSlice(
	ctx: PhaseContext,
	def: SliceDefinition,
	record: SliceRecord,
	paths: ExecuteArtifactsPaths,
	currentBranch: string,
	slug: string,
	totalCostUsd: number,
	totalDurationMs: number,
	lastExecutedIndex: number,
): Promise<SliceStepResult> {
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
		return {
			done: true,
			loopResult: {
				failure,
				costUsd: totalCostUsd,
				durationMs: totalDurationMs,
				lastExecutedIndex,
			},
		};
	}

	return {
		done: false,
		costUsd: outcome.costUsd,
		durationMs: outcome.durationMs,
		branch: buildSliceBranchName(slug, def.index),
	};
}

export async function executeSlicesSequentially(
	ctx: PhaseContext,
	sliceDefs: SliceDefinition[],
	paths: ExecuteArtifactsPaths,
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
			totalCostUsd += Number(record.costUsd);
			totalDurationMs += Number(record.durationMs);
			lastExecutedIndex = def.index;
			// Advance currentBranch so the next pending slice branches from the right place.
			currentBranch = buildSliceBranchName(slug, def.index);
			continue;
		}

		if (record.status === "failed") {
			const failure = makeFailedResult(
				`Slice ${def.index} (${def.name}) previously failed: ${record.error ?? "unknown error"}. Resolve the issue before retrying.`,
				{ costUsd: totalCostUsd, durationMs: totalDurationMs },
			);
			return { failure, costUsd: totalCostUsd, durationMs: totalDurationMs, lastExecutedIndex };
		}

		let step: SliceStepResult;
		if (record.status === "awaiting_approval") {
			step = await processAwaitingApprovalSlice(
				ctx,
				def,
				record,
				paths,
				slug,
				totalCostUsd,
				totalDurationMs,
				lastExecutedIndex,
			);
		} else {
			step = await executeFreshSlice(
				ctx,
				def,
				record,
				paths,
				currentBranch,
				slug,
				totalCostUsd,
				totalDurationMs,
				lastExecutedIndex,
			);
		}
		if (step.done) {
			return step.loopResult;
		}
		totalCostUsd += step.costUsd;
		totalDurationMs += step.durationMs;
		lastExecutedIndex = def.index;
		// Update currentBranch and persist per-slice so resume picks up from the right place.
		currentBranch = step.branch;
		ctx.state.runs.update(ctx.runId, { workingBranch: currentBranch });
	}

	return { costUsd: totalCostUsd, durationMs: totalDurationMs, lastExecutedIndex };
}
