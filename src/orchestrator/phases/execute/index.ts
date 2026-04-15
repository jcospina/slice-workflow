import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PhaseContext, PhaseResult } from "../types";
import { makeFailedResult, toErrorMessage } from "./common";
import { findTrackFile, parsePlanSlices, parseReviewOutput } from "./parsers";
import { executeSlicesSequentially, seedSliceRecords } from "./sequential";

/**
 * Execute-phase entrypoint and public helpers.
 * Public exports remain stable so external imports can continue using `./phases/execute`.
 */
export { findTrackFile, parsePlanSlices, parseReviewOutput };

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
