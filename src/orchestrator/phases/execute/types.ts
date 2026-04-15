import type { ReviewFinding } from "../../../prompts/types";
import type { ReviewVerdict } from "../../../state/types";
import type { ApprovalDecision, PhaseResult } from "../types";

/** Parsed from plan headers like `### Slice NN - Name`. */
export interface SliceDefinition {
	index: number;
	name: string;
	dod: string;
}

export interface ParsedReview {
	verdict: ReviewVerdict;
	confidence: number;
	summary: string;
	findings: ReviewFinding[];
}

export interface ReviewLoopOutcome {
	passed: boolean;
	escalationError?: string;
	totalCostUsd: number;
	totalDurationMs: number;
}

export interface IterationResult {
	verdict: ReviewVerdict;
	summary: string;
	findings: ReviewFinding[];
	costUsd: number;
	durationMs: number;
}

export interface SliceOutcome {
	/** Populated when the slice fails; callers propagate this as the phase result. */
	failure?: PhaseResult;
	costUsd: number;
	durationMs: number;
}

export interface SlicePaths {
	planPath: string;
	progressPath: string;
	trackPath: string;
}

export interface SliceApprovalResult {
	decision: ApprovalDecision;
	feedback: string | null;
	failure?: PhaseResult;
}

export interface SliceLoopResult {
	failure?: PhaseResult;
	costUsd: number;
	durationMs: number;
	lastExecutedIndex: number;
}

export interface ExecuteArtifactsPaths {
	planPath: string;
	progressPath: string;
	tracksDir: string;
}
