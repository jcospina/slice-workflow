import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentRunResult } from "../../runtime/types";
import type { PhaseContext, PhaseResult } from "./types";

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

export async function runRfcDraftPhase(ctx: PhaseContext): Promise<PhaseResult> {
	const artifactPath = join(ctx.implementationsDir, ctx.run.slug, "rfc-draft.md");

	try {
		await mkdir(dirname(artifactPath), { recursive: true });
	} catch (error) {
		return makeFailedResult(
			`Failed to prepare RFC artifact directory for '${artifactPath}': ${toErrorMessage(error)}`,
		);
	}

	let systemPrompt: string;
	let taskPrompt: string;
	try {
		systemPrompt = await ctx.prompts.buildSystemPrompt("rfc-draft", ctx);
		taskPrompt = await ctx.prompts.buildTaskPrompt("rfc-draft", ctx);
	} catch (error) {
		return makeFailedResult(`Failed to build RFC draft prompt: ${toErrorMessage(error)}`);
	}

	const promptSections = [
		ctx.run.taskDescription.trim()
			? `Workflow task description:\n${ctx.run.taskDescription.trim()}`
			: "",
		taskPrompt.trim(),
	].filter(Boolean);
	const prompt = promptSections.join("\n\n");

	let interactiveResult: AgentRunResult;
	try {
		interactiveResult = await ctx.runtime.runInteractive({
			cwd: ctx.projectCwd,
			systemPrompt,
			prompt,
			rfcArtifactPath: artifactPath,
		});
	} catch (error) {
		return makeFailedResult(`RFC draft interactive session failed: ${toErrorMessage(error)}`);
	}

	if (!interactiveResult.success) {
		return makeFailedResult(
			interactiveResult.error ??
				interactiveResult.output ??
				"RFC draft interactive session failed.",
			{
				agentSessionId: interactiveResult.sessionId,
				costUsd: interactiveResult.costUsd,
				durationMs: interactiveResult.durationMs,
			},
		);
	}

	try {
		await access(artifactPath);
	} catch {
		return makeFailedResult(
			`RFC draft artifact was not created at '${artifactPath}'. Complete the session by writing the RFC to that path before exiting.`,
			{
				agentSessionId: interactiveResult.sessionId,
				costUsd: interactiveResult.costUsd,
				durationMs: interactiveResult.durationMs,
			},
		);
	}

	return {
		status: "completed",
		agentSessionId: interactiveResult.sessionId,
		costUsd: interactiveResult.costUsd,
		durationMs: interactiveResult.durationMs,
		error: null,
		output: artifactPath,
	};
}
