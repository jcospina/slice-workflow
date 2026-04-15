import type { PhaseContext } from "../types";
import { buildSliceBranchName, makeFailedResult } from "./common";
import { findTrackFile } from "./parsers";
import { requestSliceApproval, resumeSliceFromRequestChanges, runSingleSlice } from "./slice";
import type { ExecuteArtifactsPaths, SliceDefinition, SliceLoopResult } from "./types";

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
		const currentRecord = record;

		if (currentRecord.status === "awaiting_approval") {
			const trackPath = await findTrackFile(paths.tracksDir, def.index);
			if (!trackPath) {
				const error = `Track file for slice ${def.index} (${def.name}) not found in '${paths.tracksDir}'. Expected a file matching '${String(def.index).padStart(2, "0")}-*.md'.`;
				ctx.state.slices.update(currentRecord.id, {
					status: "failed",
					error,
					endedAt: new Date().toISOString(),
				});
				const failure = makeFailedResult(error, {
					costUsd: totalCostUsd,
					durationMs: totalDurationMs,
				});
				return { failure, costUsd: totalCostUsd, durationMs: totalDurationMs, lastExecutedIndex };
			}

			const approval = await requestSliceApproval(ctx, def, currentRecord, trackPath);
			if (approval.failure) {
				const failure = {
					...approval.failure,
					costUsd: (approval.failure.costUsd ?? 0) + totalCostUsd,
					durationMs: (approval.failure.durationMs ?? 0) + totalDurationMs,
				};
				return { failure, costUsd: totalCostUsd, durationMs: totalDurationMs, lastExecutedIndex };
			}

			if (approval.decision === "approved") {
				const approvedRecord = ctx.state.slices.getByIndex(ctx.runId, def.index) ?? currentRecord;
				totalCostUsd += approvedRecord.costUsd ?? 0;
				totalDurationMs += approvedRecord.durationMs ?? 0;
				lastExecutedIndex = def.index;
				currentBranch = buildSliceBranchName(slug, def.index);
				ctx.state.runs.update(ctx.runId, { workingBranch: currentBranch });
				continue;
			}

			// Resume request_changes using the existing slice branch so feedback is preserved.
			const resumed = await resumeSliceFromRequestChanges(
				ctx,
				def,
				currentRecord,
				paths,
				approval.feedback ?? "",
			);
			if (resumed.failure) {
				const failure = {
					...resumed.failure,
					costUsd: (resumed.failure.costUsd ?? 0) + totalCostUsd,
					durationMs: (resumed.failure.durationMs ?? 0) + totalDurationMs,
				};
				return { failure, costUsd: totalCostUsd, durationMs: totalDurationMs, lastExecutedIndex };
			}

			const resumedRecord = ctx.state.slices.getByIndex(ctx.runId, def.index) ?? currentRecord;
			totalCostUsd += resumedRecord.costUsd ?? 0;
			totalDurationMs += resumedRecord.durationMs ?? 0;
			lastExecutedIndex = def.index;
			currentBranch = buildSliceBranchName(slug, def.index);
			ctx.state.runs.update(ctx.runId, { workingBranch: currentBranch });
			continue;
		}

		if (currentRecord.status === "completed") {
			totalCostUsd += currentRecord.costUsd ?? 0;
			totalDurationMs += currentRecord.durationMs ?? 0;
			lastExecutedIndex = def.index;
			// Advance currentBranch so the next pending slice branches from the right place.
			currentBranch = buildSliceBranchName(slug, def.index);
			continue;
		}

		if (currentRecord.status === "failed") {
			const failure = makeFailedResult(
				`Slice ${def.index} (${def.name}) previously failed: ${currentRecord.error ?? "unknown error"}. Resolve the issue before retrying.`,
				{ costUsd: totalCostUsd, durationMs: totalDurationMs },
			);
			return { failure, costUsd: totalCostUsd, durationMs: totalDurationMs, lastExecutedIndex };
		}

		ctx.state.slices.update(currentRecord.id, {
			status: "running",
			startedAt: new Date().toISOString(),
		});
		ctx.onEvent?.({
			type: "slice_started",
			runId: ctx.runId,
			sliceIndex: def.index,
			sliceName: def.name,
		});

		const outcome = await runSingleSlice(ctx, def, currentRecord, paths, currentBranch);

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
		currentBranch = buildSliceBranchName(slug, def.index);
		ctx.state.runs.update(ctx.runId, { workingBranch: currentBranch });
	}

	return { costUsd: totalCostUsd, durationMs: totalDurationMs, lastExecutedIndex };
}
