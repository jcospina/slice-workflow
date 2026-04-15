import type { ResolvedConfig } from "../../config/types";
import type { BuiltPrompt, PromptBuildInput, PromptTemplatePhase } from "../../prompts/types";
import type { AgentRuntime } from "../../runtime/types";
import type { StateManager } from "../../state";
import type { NotificationChannel, PhaseName, ResumeContext, WorkflowRun } from "../../state/types";

// --- Phase enum ---

export const Phase = {
	rfcDraft: "rfc-draft",
	draftPolish: "draft-polish",
	plan: "plan",
	execute: "execute",
	handoff: "handoff",
} as const;

// --- Collaborator interfaces ---

export interface WorktreeManager {
	/** Create an isolated worktree for a slice on a new branch. Returns the absolute path. */
	create(options: {
		runId: string;
		slug: string;
		sliceIndex: number;
		baseBranch: string;
	}): Promise<string>;

	/** Install dependencies and copy environment files in the worktree. */
	setup(worktreePath: string): Promise<void>;

	/** Remove the worktree. */
	remove(worktreePath: string): Promise<void>;

	/** Run git worktree prune to recover from stale lock files. */
	prune(): Promise<void>;
}

export type ApprovalDecision = "approved" | "request_changes" | "rejected";

export interface ApprovalRequest {
	runId: string;
	phase: PhaseName;
	/** Absolute path to the RFC or plan document for display in messaging channels. */
	artifactPath: string;
	/** Text content to send to messaging channels. */
	content: string;
}

export interface ApprovalResponse {
	decision: ApprovalDecision;
	/** Populated when decision is "request_changes". */
	feedback: string | null;
	respondedAt: string;
	channel: NotificationChannel;
}

export interface MessagingManager {
	/** Send an approval request and wait for the first response. */
	requestApproval(request: ApprovalRequest): Promise<ApprovalResponse>;

	/** Gracefully shut down messaging connections. */
	close(): Promise<void>;
}

export interface PromptBuilder {
	/** Build all layers (system + context + task) and return a composed prompt. */
	buildPrompt(phase: PromptTemplatePhase, input: PromptBuildInput): Promise<BuiltPrompt>;

	/** Build the system prompt for a given phase. */
	buildSystemPrompt(phase: PhaseName, ctx: PhaseContext): Promise<string>;

	/** Build the task prompt (user-facing instructions) for a given phase. */
	buildTaskPrompt(phase: PhaseName, ctx: PhaseContext): Promise<string>;
}

// --- Phase contracts ---

export interface PhaseContext {
	runId: string;
	run: WorkflowRun;
	phase: PhaseName;
	config: ResolvedConfig;
	runtime: AgentRuntime;
	state: StateManager;
	worktree: WorktreeManager;
	messaging: MessagingManager;
	prompts: PromptBuilder;
	/** Repo root — agent CWD for non-execute phases. */
	projectCwd: string;
	/** Absolute path resolved from config.implementationsDir + projectCwd. */
	implementationsDir: string;
	/** Populated when resuming an interrupted run; undefined for fresh runs. */
	resumeContext: ResumeContext | undefined;
	/** TUI live-update callback — undefined when no TUI is attached. */
	onEvent: OrchestratorEventCallback | undefined;
}

export interface PhaseResult {
	status: "completed" | "failed" | "skipped";
	agentSessionId: string | null;
	costUsd: number | null;
	durationMs: number | null;
	error: string | null;
	/** Final agent text output or artifact path hint for approval gates. */
	output: string | null;
}

export type PhaseHandler = (ctx: PhaseContext) => Promise<PhaseResult>;

// --- Orchestrator event types ---

export type OrchestratorEvent =
	| { type: "phase_started"; runId: string; phase: PhaseName }
	| {
			type: "phase_completed";
			runId: string;
			phase: PhaseName;
			costUsd: number | null;
			durationMs: number | null;
	  }
	| { type: "phase_failed"; runId: string; phase: PhaseName; error: string }
	| { type: "phase_skipped"; runId: string; phase: PhaseName }
	| { type: "approval_pending"; runId: string; phase: PhaseName; artifactPath: string }
	| {
			type: "approval_resolved";
			runId: string;
			phase: PhaseName;
			decision: ApprovalDecision;
	  }
	| { type: "slice_started"; runId: string; sliceIndex: number; sliceName: string }
	| { type: "slice_completed"; runId: string; sliceIndex: number; costUsd: number | null }
	| { type: "slice_failed"; runId: string; sliceIndex: number; error: string }
	| {
			type: "slice_turn_warning";
			runId: string;
			sliceIndex: number;
			turnNumber: number;
			maxTurns: number;
	  }
	| { type: "workflow_completed"; runId: string; totalCostUsd: number }
	| { type: "workflow_failed"; runId: string; error: string };

export type OrchestratorEventCallback = (event: OrchestratorEvent) => void;
