import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentRunResult, ProgressEvent } from "../../runtime/types";
import type { PhaseContext, PhaseResult } from "./types";

export interface DraftPolishArtifacts {
	inputPath: string;
	outputPath: string;
}

const MARKDOWN_FENCE_PATTERN = /^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i;
const PERMISSION_DENIED_PATTERN = /(permission denied|write .* denied|grant write permission)/i;
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

function getDefaultArtifacts(ctx: PhaseContext): DraftPolishArtifacts {
	const artifactRoot = join(ctx.implementationsDir, ctx.run.slug);
	return {
		inputPath: join(artifactRoot, "rfc-draft.md"),
		outputPath: join(artifactRoot, "rfc.md"),
	};
}

function buildPromptSections(
	ctx: PhaseContext,
	taskPrompt: string,
	artifacts: DraftPolishArtifacts,
): string {
	return [
		ctx.run.taskDescription.trim()
			? `Workflow task description:\n${ctx.run.taskDescription.trim()}`
			: "",
		`Input RFC draft path:\n${artifacts.inputPath}`,
		taskPrompt.trim(),
		[
			"Critical requirement:",
			"- You MUST write the final polished RFC to the filesystem path below before finishing.",
			"- Do NOT print the polished RFC body in chat output.",
			"- After writing the file, return only: DONE",
			`Required output file path:\n${artifacts.outputPath}`,
		].join("\n\n"),
	]
		.filter(Boolean)
		.join("\n\n");
}

function createPhaseProgressHandler(): (event: ProgressEvent) => void {
	return (_event: ProgressEvent) => {
		// Intentionally phase-local. Top-level orchestrator events currently do not
		// include a progress event contract.
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

function isPermissionDeniedOutput(output: string): boolean {
	return PERMISSION_DENIED_PATTERN.test(output);
}

function extractMarkdownFromRunOutput(output: string): string | null {
	const trimmed = output.trim();
	if (trimmed.length === 0) {
		return null;
	}

	const fenced = MARKDOWN_FENCE_PATTERN.exec(trimmed);
	const markdown = fenced ? fenced[1].trim() : trimmed;
	if (markdown.length === 0) {
		return null;
	}

	return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}

async function validateInputArtifact(inputPath: string): Promise<string | null> {
	try {
		await access(inputPath);
		return null;
	} catch {
		return `Draft polish requires an RFC draft at '${inputPath}', but the file does not exist.`;
	}
}

async function prepareOutputDirectory(outputPath: string): Promise<string | null> {
	try {
		await mkdir(dirname(outputPath), { recursive: true });
		return null;
	} catch (error) {
		return `Failed to prepare polished RFC artifact directory for '${outputPath}': ${toErrorMessage(error)}`;
	}
}

async function buildDraftPolishPrompts(
	ctx: PhaseContext,
	artifacts: DraftPolishArtifacts,
): Promise<{ systemPrompt: string; prompt: string }> {
	const built = await ctx.prompts.buildPrompt("draft-polish", {
		slug: ctx.run.slug,
		runId: ctx.runId,
		taskDescription: ctx.run.taskDescription,
		topLevelPhase: ctx.phase,
		includeContext: false,
	});

	return {
		systemPrompt: built.layers.system,
		prompt: buildPromptSections(ctx, built.layers.task, artifacts),
	};
}

async function runDraftPolishAgent(
	ctx: PhaseContext,
	options: { systemPrompt: string; prompt: string; inputPath: string; allowedTools?: string[] },
): Promise<AgentRunResult> {
	return await ctx.runtime.run({
		cwd: ctx.projectCwd,
		systemPrompt: options.systemPrompt,
		contextFiles: [options.inputPath],
		allowedTools: options.allowedTools,
		prompt: options.prompt,
		onProgress: createPhaseProgressHandler(),
	});
}

async function ensureOutputArtifactReady(
	outputPath: string,
	runResult: AgentRunResult,
): Promise<string | null> {
	try {
		await access(outputPath);
		return null;
	} catch {
		if (isPermissionDeniedOutput(runResult.output)) {
			return `Draft polish could not write '${outputPath}' due to runtime permission denial. Ensure autonomous runs allow file write/edit tools.`;
		}

		const fallbackMarkdown = extractMarkdownFromRunOutput(runResult.output);
		if (fallbackMarkdown) {
			try {
				await writeFile(outputPath, fallbackMarkdown, "utf-8");
			} catch (error) {
				return `Draft polish completed but failed to persist fallback output to '${outputPath}': ${toErrorMessage(error)}`;
			}
		}
	}

	try {
		await access(outputPath);
		return null;
	} catch {
		return `Draft polish output artifact was not created at '${outputPath}'. Ensure the polished RFC is written to that path before finishing.`;
	}
}

export async function runDraftPolishWithArtifacts(
	ctx: PhaseContext,
	artifacts: DraftPolishArtifacts,
): Promise<PhaseResult> {
	const inputError = await validateInputArtifact(artifacts.inputPath);
	if (inputError) {
		return makeFailedResult(inputError);
	}

	const outputDirError = await prepareOutputDirectory(artifacts.outputPath);
	if (outputDirError) {
		return makeFailedResult(outputDirError);
	}

	let promptParts: { systemPrompt: string; prompt: string };
	try {
		promptParts = await buildDraftPolishPrompts(ctx, artifacts);
	} catch (error) {
		return makeFailedResult(`Failed to build draft polish prompt: ${toErrorMessage(error)}`);
	}

	const allowedTools = getAllowedToolsForRuntime(ctx.runtime.provider);

	let runResult: AgentRunResult;
	try {
		runResult = await runDraftPolishAgent(ctx, {
			systemPrompt: promptParts.systemPrompt,
			prompt: promptParts.prompt,
			inputPath: artifacts.inputPath,
			allowedTools,
		});
	} catch (error) {
		return makeFailedResult(`draft polish run failed: ${toErrorMessage(error)}`);
	}

	if (!runResult.success) {
		return makeFailedResult(runResult.error ?? runResult.output ?? "Draft polish run failed.", {
			agentSessionId: runResult.sessionId,
			costUsd: runResult.costUsd,
			durationMs: runResult.durationMs,
		});
	}

	const outputError = await ensureOutputArtifactReady(artifacts.outputPath, runResult);
	if (outputError) {
		return makeFailedResult(outputError, {
			agentSessionId: runResult.sessionId,
			costUsd: runResult.costUsd,
			durationMs: runResult.durationMs,
		});
	}

	return {
		status: "completed",
		agentSessionId: runResult.sessionId,
		costUsd: runResult.costUsd,
		durationMs: runResult.durationMs,
		error: null,
		output: artifacts.outputPath,
	};
}

export async function runDraftPolishPhase(ctx: PhaseContext): Promise<PhaseResult> {
	return await runDraftPolishWithArtifacts(ctx, getDefaultArtifacts(ctx));
}
