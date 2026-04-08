import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentRunResult } from "../../runtime/types";
import type { PhaseContext, PhaseResult } from "./types";

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

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

export interface PlanPhaseInputs {
	/** Absolute path to the polished RFC to load as context. When undefined the session starts without RFC context. */
	rfcPath?: string;
}

export async function runPlanWithInputs(
	ctx: PhaseContext,
	inputs: PlanPhaseInputs,
): Promise<PhaseResult> {
	const artifactPath = join(ctx.implementationsDir, ctx.run.slug, `${ctx.run.slug}.md`);

	try {
		await mkdir(dirname(artifactPath), { recursive: true });
	} catch (error) {
		return makeFailedResult(
			`Failed to prepare plan artifact directory for '${artifactPath}': ${toErrorMessage(error)}`,
		);
	}

	let systemPrompt: string;
	let taskPrompt: string;
	try {
		systemPrompt = await ctx.prompts.buildSystemPrompt("plan", ctx);
		taskPrompt = await ctx.prompts.buildTaskPrompt("plan", ctx);
	} catch (error) {
		return makeFailedResult(`Failed to build plan prompt: ${toErrorMessage(error)}`);
	}

	const promptSections = [
		ctx.run.taskDescription.trim()
			? `Workflow task description:\n${ctx.run.taskDescription.trim()}`
			: "",
		inputs.rfcPath ? `Polished RFC to read before planning:\n${inputs.rfcPath}` : "",
		taskPrompt.trim(),
	].filter(Boolean);
	const prompt = promptSections.join("\n\n");

	let interactiveResult: AgentRunResult;
	try {
		interactiveResult = await ctx.runtime.runInteractive({
			cwd: ctx.projectCwd,
			systemPrompt,
			prompt,
		});
	} catch (error) {
		return makeFailedResult(`Plan interactive session failed: ${toErrorMessage(error)}`);
	}

	// Artifact existence is the primary success signal.
	// A plan written before ctrl+c is a valid completion — do not gate on exit code.
	try {
		await access(artifactPath);
	} catch {
		const hint = interactiveResult.success
			? "The agent exited without writing the plan document."
			: "The session ended (or was interrupted) without writing the plan. " +
				"If you intended to reject the plan, start a fresh run.";
		return makeFailedResult(`Plan artifact was not created at '${artifactPath}'. ${hint}`, {
			agentSessionId: interactiveResult.sessionId,
			costUsd: interactiveResult.costUsd,
			durationMs: interactiveResult.durationMs,
		});
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

export async function runPlanPhase(ctx: PhaseContext): Promise<PhaseResult> {
	const defaultRfcPath = join(ctx.implementationsDir, ctx.run.slug, "rfc.md");
	const rfcPath = (await fileExists(defaultRfcPath)) ? defaultRfcPath : undefined;
	return runPlanWithInputs(ctx, { rfcPath });
}
