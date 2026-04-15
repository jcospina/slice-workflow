import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewFinding } from "../../../prompts/types";
import {
	type SliceExecutionContext,
	buildSliceExecutionContext,
} from "../../../runtime/slice-context";
import type { AgentRunResult } from "../../../runtime/types";
import type { SliceRecord } from "../../../state/types";
import type { PhaseContext } from "../types";
import {
	buildSliceApprovalMessage,
	buildSliceBranchName,
	getAllowedToolsForRuntime,
	getMaxTurnsForSlice,
	makeFailedResult,
	toErrorMessage,
} from "./common";
import { findTrackFile } from "./parsers";
import { buildFixPrompts, runReviewLoop } from "./review";
import type {
	ExecuteArtifactsPaths,
	SliceApprovalResult,
	SliceDefinition,
	SliceOutcome,
	SlicePaths,
} from "./types";

/**
 * Slice-level execution flow: build context/prompts, run agents, handle review,
 * request changes passes, gated approval loop, and worktree lifecycle.
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

async function applyRunResult(
	ctx: PhaseContext,
	def: SliceDefinition,
	record: SliceRecord,
	runResult: AgentRunResult,
	worktreePath: string,
	turnsUsed: number,
): Promise<SliceOutcome> {
	const endedAt = new Date().toISOString();

	if (!runResult.success) {
		const msg = runResult.error ?? runResult.output ?? `Slice ${def.index} agent run failed.`;
		ctx.state.slices.update(record.id, {
			status: "failed",
			agentSessionId: runResult.sessionId,
			costUsd: runResult.costUsd,
			durationMs: runResult.durationMs,
			turnsUsed,
			error: msg,
			endedAt,
		});
		ctx.onEvent?.({
			type: "slice_failed",
			runId: ctx.runId,
			sliceIndex: def.index,
			sliceName: def.name,
			error: msg,
		});
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
		turnsUsed,
		endedAt,
	});
	ctx.onEvent?.({
		type: "slice_completed",
		runId: ctx.runId,
		sliceIndex: def.index,
		sliceName: def.name,
		costUsd: runResult.costUsd,
		durationMs: runResult.durationMs,
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

async function buildSliceContext(
	ctx: PhaseContext,
	def: SliceDefinition,
	paths: SlicePaths,
	worktreePath: string,
): Promise<SliceExecutionContext> {
	const costSummary = ctx.state.getRunCostSummary(ctx.runId);
	return await buildSliceExecutionContext({
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
}

async function runSliceExecutionPass(
	ctx: PhaseContext,
	def: SliceDefinition,
	record: SliceRecord,
	paths: SlicePaths,
	worktreePath: string,
): Promise<SliceOutcome> {
	let sliceCtx: SliceExecutionContext;
	try {
		sliceCtx = await buildSliceContext(ctx, def, paths, worktreePath);
	} catch (error) {
		const msg = `Failed to build slice context for slice ${def.index} (${def.name}): ${toErrorMessage(error)}`;
		ctx.state.slices.update(record.id, {
			status: "failed",
			error: msg,
			endedAt: new Date().toISOString(),
		});
		ctx.onEvent?.({
			type: "slice_failed",
			runId: ctx.runId,
			sliceIndex: def.index,
			sliceName: def.name,
			error: msg,
		});
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
		ctx.onEvent?.({
			type: "slice_failed",
			runId: ctx.runId,
			sliceIndex: def.index,
			sliceName: def.name,
			error: msg,
		});
		return { failure: makeFailedResult(msg), costUsd: 0, durationMs: 0 };
	}

	const maxTurns = getMaxTurnsForSlice(ctx.config);
	let turnsUsed = 0;
	let warnFired = false;
	const warnThreshold = Math.floor(maxTurns * 0.8);

	const runResult = await ctx.runtime.run({
		cwd: worktreePath,
		systemPrompt: prompts.systemPrompt,
		prompt: prompts.prompt,
		allowedTools: getAllowedToolsForRuntime(ctx.runtime.provider),
		maxTurns,
		onProgress: (event) => {
			if (event.type === "turn_complete") {
				turnsUsed = event.turnNumber;
				if (!warnFired && event.turnNumber > warnThreshold) {
					warnFired = true;
					ctx.onEvent?.({
						type: "slice_turn_warning",
						runId: ctx.runId,
						sliceIndex: def.index,
						turnNumber: event.turnNumber,
						maxTurns,
					});
				}
			}
		},
	});

	// Implementer succeeded. Run review loop if enabled before marking slice complete.
	if (runResult.success && ctx.config.review.enabled) {
		const reviewOutcome = await runReviewLoop(ctx, def, sliceCtx, worktreePath);
		if (!reviewOutcome.passed) {
			const endedAt = new Date().toISOString();
			const msg = reviewOutcome.escalationError ?? `Slice ${def.index} review escalated.`;
			ctx.state.slices.update(record.id, {
				status: "failed",
				agentSessionId: runResult.sessionId,
				costUsd: (runResult.costUsd ?? 0) + reviewOutcome.totalCostUsd,
				durationMs: (runResult.durationMs ?? 0) + reviewOutcome.totalDurationMs,
				turnsUsed,
				error: msg,
				endedAt,
			});
			ctx.onEvent?.({
				type: "slice_failed",
				runId: ctx.runId,
				sliceIndex: def.index,
				sliceName: def.name,
				error: msg,
			});
			return {
				failure: makeFailedResult(msg, {
					agentSessionId: runResult.sessionId,
					costUsd: (runResult.costUsd ?? 0) + reviewOutcome.totalCostUsd,
					durationMs: (runResult.durationMs ?? 0) + reviewOutcome.totalDurationMs,
				}),
				costUsd: (runResult.costUsd ?? 0) + reviewOutcome.totalCostUsd,
				durationMs: (runResult.durationMs ?? 0) + reviewOutcome.totalDurationMs,
			};
		}
		// Review passed: combine review costs into the result before marking complete.
		return applyRunResult(
			ctx,
			def,
			record,
			{
				...runResult,
				costUsd: (runResult.costUsd ?? 0) + reviewOutcome.totalCostUsd,
				durationMs: (runResult.durationMs ?? 0) + reviewOutcome.totalDurationMs,
			},
			worktreePath,
			turnsUsed,
		);
	}

	return applyRunResult(ctx, def, record, runResult, worktreePath, turnsUsed);
}

/**
 * Runs a single "request changes" follow-up pass in the existing worktree.
 * This must spawn a fresh agent session and feed user feedback directly.
 */
async function runRequestChangesPass(
	ctx: PhaseContext,
	def: SliceDefinition,
	record: SliceRecord,
	paths: SlicePaths,
	worktreePath: string,
	feedback: string,
): Promise<SliceOutcome> {
	let sliceCtx: SliceExecutionContext;
	try {
		sliceCtx = await buildSliceContext(ctx, def, paths, worktreePath);
	} catch (error) {
		const msg = `Failed to build slice context for feedback pass on slice ${def.index} (${def.name}): ${toErrorMessage(error)}`;
		ctx.state.slices.update(record.id, {
			status: "failed",
			error: msg,
			endedAt: new Date().toISOString(),
		});
		ctx.onEvent?.({
			type: "slice_failed",
			runId: ctx.runId,
			sliceIndex: def.index,
			sliceName: def.name,
			error: msg,
		});
		return { failure: makeFailedResult(msg), costUsd: 0, durationMs: 0 };
	}

	const feedbackFinding: ReviewFinding = {
		severity: "major",
		file: paths.trackPath,
		title: "User requested changes",
		body: feedback.trim() || "No feedback text was provided.",
		dodItem: "Approval feedback",
	};

	let fixPrompts: { systemPrompt: string; prompt: string };
	try {
		fixPrompts = await buildFixPrompts(ctx, def, sliceCtx, 1, [feedbackFinding]);
	} catch {
		fixPrompts = {
			systemPrompt: "Role: Slice implementer applying requested changes.",
			prompt: `Apply requested changes for slice ${def.index} (${def.name}). Feedback:\n${feedback}`,
		};
	}

	const runResult = await ctx.runtime.run({
		cwd: worktreePath,
		systemPrompt: fixPrompts.systemPrompt,
		prompt: fixPrompts.prompt,
		allowedTools: getAllowedToolsForRuntime(ctx.runtime.provider),
		maxTurns: getMaxTurnsForSlice(ctx.config),
	});

	if (!runResult.success) {
		const msg =
			runResult.error ??
			runResult.output ??
			`Slice ${def.index} (${def.name}) failed while applying requested changes.`;
		const previous = ctx.state.slices.getByIndex(ctx.runId, def.index);
		ctx.state.slices.update(record.id, {
			status: "failed",
			agentSessionId: runResult.sessionId,
			costUsd: (previous?.costUsd ?? 0) + (runResult.costUsd ?? 0),
			durationMs: (previous?.durationMs ?? 0) + (runResult.durationMs ?? 0),
			error: msg,
			endedAt: new Date().toISOString(),
		});
		ctx.onEvent?.({
			type: "slice_failed",
			runId: ctx.runId,
			sliceIndex: def.index,
			sliceName: def.name,
			error: msg,
		});
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

	let passCost = runResult.costUsd ?? 0;
	let passDuration = runResult.durationMs ?? 0;
	if (ctx.config.review.enabled) {
		const reviewOutcome = await runReviewLoop(ctx, def, sliceCtx, worktreePath);
		passCost += reviewOutcome.totalCostUsd;
		passDuration += reviewOutcome.totalDurationMs;
		if (!reviewOutcome.passed) {
			const msg =
				reviewOutcome.escalationError ?? `Slice ${def.index} (${def.name}) review escalated.`;
			const previous = ctx.state.slices.getByIndex(ctx.runId, def.index);
			ctx.state.slices.update(record.id, {
				status: "failed",
				agentSessionId: runResult.sessionId,
				costUsd: (previous?.costUsd ?? 0) + passCost,
				durationMs: (previous?.durationMs ?? 0) + passDuration,
				error: msg,
				endedAt: new Date().toISOString(),
			});
			ctx.onEvent?.({
				type: "slice_failed",
				runId: ctx.runId,
				sliceIndex: def.index,
				sliceName: def.name,
				error: msg,
			});
			return {
				failure: makeFailedResult(msg, {
					agentSessionId: runResult.sessionId,
					costUsd: passCost,
					durationMs: passDuration,
				}),
				costUsd: passCost,
				durationMs: passDuration,
			};
		}
	}

	const previous = ctx.state.slices.getByIndex(ctx.runId, def.index);
	const totalCost = (previous?.costUsd ?? 0) + passCost;
	const totalDuration = (previous?.durationMs ?? 0) + passDuration;

	ctx.state.slices.update(record.id, {
		status: "completed",
		agentSessionId: runResult.sessionId,
		costUsd: totalCost,
		durationMs: totalDuration,
		error: null,
		endedAt: new Date().toISOString(),
	});
	ctx.onEvent?.({
		type: "slice_completed",
		runId: ctx.runId,
		sliceIndex: def.index,
		sliceName: def.name,
		costUsd: passCost,
		durationMs: passDuration,
	});

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

	return { costUsd: passCost, durationMs: passDuration };
}

/** Runs the agent inside the worktree after it has been created and set up. */
async function runSliceInWorktree(
	ctx: PhaseContext,
	def: SliceDefinition,
	record: SliceRecord,
	paths: SlicePaths,
	worktreePath: string,
): Promise<SliceOutcome> {
	await ctx.worktree.setup(worktreePath);
	return await runSliceExecutionPass(ctx, def, record, paths, worktreePath);
}

export async function requestSliceApproval(
	ctx: PhaseContext,
	def: SliceDefinition,
	record: SliceRecord,
	artifactPath: string,
): Promise<SliceApprovalResult> {
	ctx.state.slices.update(record.id, {
		status: "awaiting_approval",
		error: null,
	});
	ctx.state.runs.update(ctx.runId, { status: "awaiting_approval" });
	ctx.onEvent?.({
		type: "slice_approval_requested",
		runId: ctx.runId,
		sliceIndex: def.index,
		sliceName: def.name,
		artifactPath,
	});

	let response: Awaited<ReturnType<PhaseContext["messaging"]["requestApproval"]>>;
	try {
		response = await ctx.messaging.requestApproval({
			runId: ctx.runId,
			phase: "execute",
			artifactPath,
			content: buildSliceApprovalMessage(def),
			approvalType: "slice",
			sliceIndex: def.index,
			sliceName: def.name,
		});
	} catch (error) {
		ctx.state.runs.update(ctx.runId, { status: "running" });
		const message = `Slice ${def.index} (${def.name}) approval request failed: ${toErrorMessage(error)}`;
		ctx.state.slices.update(record.id, {
			status: "failed",
			error: message,
			endedAt: new Date().toISOString(),
		});
		ctx.onEvent?.({
			type: "slice_failed",
			runId: ctx.runId,
			sliceIndex: def.index,
			sliceName: def.name,
			error: message,
		});
		return { decision: "rejected", feedback: null, failure: makeFailedResult(message) };
	}

	ctx.state.runs.update(ctx.runId, { status: "running" });
	ctx.onEvent?.({
		type: "slice_approval_resolved",
		runId: ctx.runId,
		sliceIndex: def.index,
		sliceName: def.name,
		decision: response.decision,
	});

	if (response.channel !== "tui") {
		const error = `Slice ${def.index} (${def.name}) approval must come from TUI, received '${response.channel}'.`;
		ctx.state.slices.update(record.id, {
			status: "failed",
			error,
			endedAt: new Date().toISOString(),
		});
		ctx.onEvent?.({
			type: "slice_failed",
			runId: ctx.runId,
			sliceIndex: def.index,
			sliceName: def.name,
			error,
		});
		return { decision: "rejected", feedback: null, failure: makeFailedResult(error) };
	}

	if (response.decision === "approved") {
		ctx.state.slices.update(record.id, {
			status: "completed",
			error: null,
			endedAt: new Date().toISOString(),
		});
		return { decision: response.decision, feedback: response.feedback };
	}

	if (response.decision === "request_changes") {
		ctx.state.slices.update(record.id, {
			status: "running",
			error: null,
			startedAt: new Date().toISOString(),
		});
		return { decision: response.decision, feedback: response.feedback };
	}

	const rejectionMessage =
		response.feedback?.trim() || `Slice ${def.index} (${def.name}) was rejected at approval gate.`;
	ctx.state.slices.update(record.id, {
		status: "failed",
		error: rejectionMessage,
		endedAt: new Date().toISOString(),
	});
	ctx.onEvent?.({
		type: "slice_failed",
		runId: ctx.runId,
		sliceIndex: def.index,
		sliceName: def.name,
		error: rejectionMessage,
	});
	return {
		decision: "rejected",
		feedback: response.feedback,
		failure: makeFailedResult(rejectionMessage),
	};
}

async function runGatedSliceApprovalLoop(
	ctx: PhaseContext,
	def: SliceDefinition,
	record: SliceRecord,
	paths: SlicePaths,
	worktreePath: string,
): Promise<SliceOutcome> {
	let totalCostUsd = 0;
	let totalDurationMs = 0;

	for (;;) {
		const approval = await requestSliceApproval(ctx, def, record, paths.trackPath);
		if (approval.failure) {
			return {
				failure: {
					...approval.failure,
					costUsd: (approval.failure.costUsd ?? 0) + totalCostUsd,
					durationMs: (approval.failure.durationMs ?? 0) + totalDurationMs,
				},
				costUsd: totalCostUsd,
				durationMs: totalDurationMs,
			};
		}

		if (approval.decision === "approved") {
			return { costUsd: totalCostUsd, durationMs: totalDurationMs };
		}

		const feedback = approval.feedback?.trim() || "No additional feedback provided.";
		const delta = await runRequestChangesPass(ctx, def, record, paths, worktreePath, feedback);
		if (delta.failure) {
			return {
				failure: {
					...delta.failure,
					costUsd: (delta.failure.costUsd ?? 0) + totalCostUsd,
					durationMs: (delta.failure.durationMs ?? 0) + totalDurationMs,
				},
				costUsd: totalCostUsd,
				durationMs: totalDurationMs,
			};
		}

		totalCostUsd += delta.costUsd;
		totalDurationMs += delta.durationMs;
	}
}

/**
 * Resume helper for slices paused at gated approval.
 * Applies the already-received request_changes feedback first, then returns to
 * the normal approval loop in a recreated worktree attached to the existing
 * slice branch.
 */
export async function resumeSliceFromRequestChanges(
	ctx: PhaseContext,
	def: SliceDefinition,
	record: SliceRecord,
	paths: ExecuteArtifactsPaths,
	feedback: string,
): Promise<SliceOutcome> {
	const trackPath = await findTrackFile(paths.tracksDir, def.index);
	if (!trackPath) {
		const error = `Track file for slice ${def.index} (${def.name}) not found in '${paths.tracksDir}'. Expected a file matching '${String(def.index).padStart(2, "0")}-*.md'.`;
		ctx.state.slices.update(record.id, {
			status: "failed",
			error,
			endedAt: new Date().toISOString(),
		});
		ctx.onEvent?.({
			type: "slice_failed",
			runId: ctx.runId,
			sliceIndex: def.index,
			sliceName: def.name,
			error,
		});
		return { failure: makeFailedResult(error), costUsd: 0, durationMs: 0 };
	}

	let worktreePath: string;
	try {
		worktreePath = await ctx.worktree.create({
			runId: ctx.runId,
			slug: ctx.run.slug,
			sliceIndex: def.index,
			baseBranch: buildSliceBranchName(ctx.run.slug, def.index),
			reuseExistingBranch: true,
		});
	} catch (error) {
		const msg = `Failed to recreate worktree for resumed request-changes on slice ${def.index} (${def.name}): ${toErrorMessage(error)}`;
		ctx.state.slices.update(record.id, {
			status: "failed",
			error: msg,
			endedAt: new Date().toISOString(),
		});
		ctx.onEvent?.({
			type: "slice_failed",
			runId: ctx.runId,
			sliceIndex: def.index,
			sliceName: def.name,
			error: msg,
		});
		return { failure: makeFailedResult(msg), costUsd: 0, durationMs: 0 };
	}

	try {
		await ctx.worktree.setup(worktreePath);

		const slicePaths: SlicePaths = {
			planPath: paths.planPath,
			progressPath: paths.progressPath,
			trackPath,
		};
		const firstDelta = await runRequestChangesPass(
			ctx,
			def,
			record,
			slicePaths,
			worktreePath,
			feedback.trim() || "No additional feedback provided.",
		);
		if (firstDelta.failure) {
			return firstDelta;
		}

		const gated = await runGatedSliceApprovalLoop(ctx, def, record, slicePaths, worktreePath);
		if (gated.failure) {
			return {
				failure: {
					...gated.failure,
					costUsd: (gated.failure.costUsd ?? 0) + firstDelta.costUsd,
					durationMs: (gated.failure.durationMs ?? 0) + firstDelta.durationMs,
				},
				costUsd: firstDelta.costUsd + gated.costUsd,
				durationMs: firstDelta.durationMs + gated.durationMs,
			};
		}

		return {
			costUsd: firstDelta.costUsd + gated.costUsd,
			durationMs: firstDelta.durationMs + gated.durationMs,
		};
	} finally {
		try {
			await ctx.worktree.remove(worktreePath);
		} catch {
			// Non-fatal: stale worktrees can be cleaned up with `slice worktree prune`.
		}
	}
}

/**
 * Executes one slice end-to-end:
 *   create worktree → setup → build prompts → run agent → mark result → sync PROGRESS.md → cleanup.
 *
 * Returns a `failure` result when the slice cannot be completed. The worktree
 * is always removed in a `finally` block regardless of outcome.
 */
export async function runSingleSlice(
	ctx: PhaseContext,
	def: SliceDefinition,
	record: SliceRecord,
	paths: ExecuteArtifactsPaths,
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
		ctx.onEvent?.({
			type: "slice_failed",
			runId: ctx.runId,
			sliceIndex: def.index,
			sliceName: def.name,
			error,
		});
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
		ctx.onEvent?.({
			type: "slice_failed",
			runId: ctx.runId,
			sliceIndex: def.index,
			sliceName: def.name,
			error: msg,
		});
		return { failure: makeFailedResult(msg), costUsd: 0, durationMs: 0 };
	}

	try {
		const slicePaths: SlicePaths = {
			planPath: paths.planPath,
			progressPath: paths.progressPath,
			trackPath,
		};
		const firstPass = await runSliceInWorktree(ctx, def, record, slicePaths, worktreePath);
		if (firstPass.failure || ctx.config.sliceExecution !== "gated") {
			return firstPass;
		}

		// Persist branch pointer before waiting so a crash during approval can resume from DB state.
		ctx.state.runs.update(ctx.runId, {
			workingBranch: buildSliceBranchName(ctx.run.slug, def.index),
		});

		const gated = await runGatedSliceApprovalLoop(ctx, def, record, slicePaths, worktreePath);
		if (gated.failure) {
			return {
				failure: {
					...gated.failure,
					costUsd: (gated.failure.costUsd ?? 0) + firstPass.costUsd,
					durationMs: (gated.failure.durationMs ?? 0) + firstPass.durationMs,
				},
				costUsd: firstPass.costUsd + gated.costUsd,
				durationMs: firstPass.durationMs + gated.durationMs,
			};
		}

		return {
			costUsd: firstPass.costUsd + gated.costUsd,
			durationMs: firstPass.durationMs + gated.durationMs,
		};
	} finally {
		try {
			await ctx.worktree.remove(worktreePath);
		} catch {
			// Non-fatal: stale worktrees can be cleaned up with `slice worktree prune`.
		}
	}
}
