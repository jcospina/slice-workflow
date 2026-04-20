import type { ReviewFinding } from "../../../prompts/types";
import type { SliceExecutionContext } from "../../../runtime/slice-context";
import type { ReviewVerdict } from "../../../state/types";
import { withRetry } from "../../../utils/retry";
import type { PhaseContext } from "../types";
import { getAllowedToolsForRuntime } from "./common";
import { parseReviewOutput } from "./parsers";
import type { IterationResult, ReviewLoopOutcome, SliceDefinition } from "./types";

/**
 * Review/fix loop for execute-phase slices.
 * This module owns reviewer parsing, persistence, escalation, and re-review cycles.
 */
async function buildReviewPrompts(
	ctx: PhaseContext,
	def: SliceDefinition,
	sliceCtx: SliceExecutionContext,
	iteration: number,
): Promise<{ systemPrompt: string; prompt: string }> {
	const built = await ctx.prompts.buildPrompt("slice-review", {
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
		review: {
			iteration,
			severityThreshold: ctx.config.review.severityThreshold,
			adversarial: ctx.config.review.adversarial,
		},
		includeContext: true,
	});
	const prompt = [built.layers.context, built.layers.task].filter(Boolean).join("\n\n");
	return { systemPrompt: built.layers.system, prompt };
}

export async function buildFixPrompts(
	ctx: PhaseContext,
	def: SliceDefinition,
	sliceCtx: SliceExecutionContext,
	iteration: number,
	findings: ReviewFinding[],
): Promise<{ systemPrompt: string; prompt: string }> {
	const built = await ctx.prompts.buildPrompt("slice-fix", {
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
		review: { iteration, severityThreshold: ctx.config.review.severityThreshold, findings },
		includeContext: true,
	});
	const prompt = [built.layers.context, built.layers.task].filter(Boolean).join("\n\n");
	return { systemPrompt: built.layers.system, prompt };
}

/** Runs the reviewer agent once and persists the verdict. Returns the parsed result. */
async function runReviewIteration(
	ctx: PhaseContext,
	def: SliceDefinition,
	sliceCtx: SliceExecutionContext,
	worktreePath: string,
	iteration: number,
): Promise<IterationResult> {
	let reviewPrompts: { systemPrompt: string; prompt: string };
	try {
		reviewPrompts = await buildReviewPrompts(ctx, def, sliceCtx, iteration);
	} catch {
		const role = ctx.config.review.adversarial ? "Adversarial" : "Cooperative";
		reviewPrompts = {
			systemPrompt: `Role: ${role} slice reviewer. Return strict JSON only with verdict PASS, FAIL, or PARTIAL.`,
			prompt: `Review slice ${def.index} (${def.name}) changes. Return JSON only: {"verdict":"FAIL","confidence":0,"summary":"Prompt build error fallback used.","findings":[]}.`,
		};
	}

	const reviewResult = await withRetry(
		() =>
			ctx.runtime.run({
				cwd: worktreePath,
				systemPrompt: reviewPrompts.systemPrompt,
				prompt: reviewPrompts.prompt,
				allowedTools: getAllowedToolsForRuntime(ctx.runtime.provider),
				maxTurns: ctx.config.execution.maxTurnsPerReview,
			}),
		ctx.config.retry,
	);

	const parsed = parseReviewOutput(reviewResult.output);
	const verdict: ReviewVerdict = parsed?.verdict ?? "FAIL";
	const confidence = parsed?.confidence ?? 0;
	const summary = parsed?.summary ?? "Reviewer output could not be parsed.";
	const findings: ReviewFinding[] = parsed?.findings ?? [];

	// Persist verdict before any branching decision — required for auditability and resume.
	ctx.state.reviews.create({
		runId: ctx.runId,
		sliceIndex: def.index,
		iteration,
		verdict,
		confidence,
		findings: JSON.stringify(findings),
		summary,
		reviewerSessionId: reviewResult.sessionId ?? null,
		costUsd: reviewResult.costUsd ?? null,
	});
	ctx.onEvent?.({
		type: "review_completed",
		runId: ctx.runId,
		sliceIndex: def.index,
		iteration,
		verdict,
	});

	return {
		verdict,
		summary,
		findings,
		costUsd: reviewResult.costUsd ?? 0,
		durationMs: reviewResult.durationMs ?? 0,
	};
}

/** Runs the fixer agent in the worktree. */
async function runFixIteration(
	ctx: PhaseContext,
	def: SliceDefinition,
	sliceCtx: SliceExecutionContext,
	worktreePath: string,
	iteration: number,
	findings: ReviewFinding[],
): Promise<{ costUsd: number; durationMs: number }> {
	let fixPrompts: { systemPrompt: string; prompt: string };
	try {
		fixPrompts = await buildFixPrompts(ctx, def, sliceCtx, iteration, findings);
	} catch {
		fixPrompts = {
			systemPrompt: "Role: Targeted fixer for reviewer findings.",
			prompt: `Fix the issues found in slice ${def.index} (${def.name}).`,
		};
	}

	const fixResult = await withRetry(
		() =>
			ctx.runtime.run({
				cwd: worktreePath,
				systemPrompt: fixPrompts.systemPrompt,
				prompt: fixPrompts.prompt,
				allowedTools: getAllowedToolsForRuntime(ctx.runtime.provider),
				maxTurns: ctx.config.execution.maxTurnsPerSlice,
			}),
		ctx.config.retry,
	);
	return { costUsd: fixResult.costUsd ?? 0, durationMs: fixResult.durationMs ?? 0 };
}

export async function runReviewLoop(
	ctx: PhaseContext,
	def: SliceDefinition,
	sliceCtx: SliceExecutionContext,
	worktreePath: string,
): Promise<ReviewLoopOutcome> {
	let totalCostUsd = 0;
	let totalDurationMs = 0;

	for (;;) {
		const iteration = ctx.state.reviews.countBySlice(ctx.runId, def.index) + 1;
		ctx.onEvent?.({ type: "review_started", runId: ctx.runId, sliceIndex: def.index, iteration });

		const iter = await runReviewIteration(ctx, def, sliceCtx, worktreePath, iteration);
		totalCostUsd += iter.costUsd;
		totalDurationMs += iter.durationMs;

		if (iter.verdict === "PASS") {
			return { passed: true, totalCostUsd, totalDurationMs };
		}

		// FAIL or PARTIAL: check if we've hit the cap.
		const count = ctx.state.reviews.countBySlice(ctx.runId, def.index);
		if (count >= ctx.config.review.maxIterations) {
			const escalationError = `Slice ${def.index} (${def.name}) failed review after ${count} iteration(s): ${iter.summary}`;
			ctx.onEvent?.({
				type: "review_escalated",
				runId: ctx.runId,
				sliceIndex: def.index,
				error: escalationError,
			});
			return { passed: false, escalationError, totalCostUsd, totalDurationMs };
		}

		// Under cap: run fixer then loop back for re-review.
		const fix = await runFixIteration(ctx, def, sliceCtx, worktreePath, iteration, iter.findings);
		totalCostUsd += fix.costUsd;
		totalDurationMs += fix.durationMs;
	}
}
