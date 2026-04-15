import type { PhaseName } from "../state/types";

export const DEFAULT_CONTEXT_BUDGET_CHARS = 120_000;

export type PromptTemplatePhase =
	| "rfc-draft"
	| "draft-polish"
	| "plan"
	| "slice-execution"
	| "slice-review"
	| "slice-fix"
	| "handoff";

export type ReviewSeverity = "critical" | "major" | "minor";

export interface PromptContextFiles {
	planPath: string;
	progressPath: string;
	currentTrackPath: string;
}

export interface PromptSliceContext {
	index: number;
	name: string;
	dod: string;
}

export interface ReviewFinding {
	severity: ReviewSeverity;
	file: string;
	title: string;
	body: string;
	dodItem?: string;
	lineRange?: [number, number];
}

export interface PromptReviewContext {
	iteration?: number;
	severityThreshold?: ReviewSeverity;
	findings?: ReviewFinding[];
}

export interface WorktreeBoundary {
	worktreePath: string;
	planDocPath: string;
	progressDocPath: string;
	trackDocPath: string;
}

export interface PromptBuildInput {
	slug: string;
	runId?: string;
	taskDescription?: string;
	topLevelPhase?: PhaseName;
	files?: PromptContextFiles;
	slice?: PromptSliceContext;
	review?: PromptReviewContext;
	maxContextChars?: number;
	includeContext?: boolean;
	worktreeBoundary?: WorktreeBoundary;
	preReadContent?: { planDoc: string; progressDoc: string; trackDoc: string };
}

export interface PromptLayers {
	system: string;
	context: string;
	task: string;
}

export interface BuiltPrompt {
	phase: PromptTemplatePhase;
	layers: PromptLayers;
	composedPrompt: string;
}

export interface PromptTemplate {
	system: string;
	task: string;
}
