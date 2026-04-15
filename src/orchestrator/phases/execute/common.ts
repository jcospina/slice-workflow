import type { PhaseContext, PhaseResult } from "../types";
import type { SliceDefinition } from "./types";

/**
 * Shared execute-phase constants and small pure helpers.
 * Keep these centralized to avoid subtle drift across submodules.
 */
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

export function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export function makeFailedResult(
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

export function getAllowedToolsForRuntime(
	provider: PhaseContext["runtime"]["provider"],
): string[] | undefined {
	if (provider === "claude-code") {
		return CLAUDE_AUTONOMOUS_ALLOWED_TOOLS;
	}
	return undefined;
}

export function getMaxTurnsForSlice(config: PhaseContext["config"]): number {
	return config.execution.maxTurnsPerSlice;
}

export function buildSliceBranchName(slug: string, sliceIndex: number): string {
	return `task/${slug}-${sliceIndex}`;
}

export function buildSliceApprovalMessage(def: SliceDefinition): string {
	return `Slice ${def.index} (${def.name}) is ready for review. Approve to continue, request changes with feedback, or reject to stop execution.`;
}
