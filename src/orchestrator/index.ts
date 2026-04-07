import { join, resolve } from "node:path";
import type { ResolvedConfig } from "../config/types";
import type { AgentRuntime } from "../runtime/types";
import type { StateManager } from "../state";
import type { PhaseName, ResumeContext, WorkflowRun } from "../state/types";
import { PhaseError, StateError } from "../utils/errors";
import { runRfcDraftPhase } from "./phases/rfc-draft";
import type {
	ApprovalDecision,
	MessagingManager,
	OrchestratorEvent,
	OrchestratorEventCallback,
	PhaseContext,
	PhaseHandler,
	PhaseResult,
	PromptBuilder,
	WorktreeManager,
} from "./phases/types";
import {
	PHASE_SEQUENCE,
	canTransition as _canTransition,
	resolveStartingPhase as _resolveStartingPhase,
} from "./state-machine";

export type {
	ApprovalDecision,
	ApprovalRequest,
	ApprovalResponse,
	MessagingManager,
	OrchestratorEvent,
	OrchestratorEventCallback,
	PhaseContext,
	PhaseHandler,
	PhaseResult,
	PromptBuilder,
	WorktreeManager,
} from "./phases/types";

export { canTransition } from "./state-machine";

// --- Constants ---

/** Maps a phase to the approvalGates config key that controls its gate. */
const APPROVAL_GATE_MAP: Partial<Record<PhaseName, keyof ResolvedConfig["approvalGates"]>> = {
	"rfc-draft": "rfc",
	plan: "plan",
};

type GateOutcome = "advance" | "repeat" | "stop";

function slugify(task: string): string {
	return task
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

// --- Stub phase handlers ---

function makeStub(phase: PhaseName): PhaseHandler {
	return () => Promise.reject(new PhaseError(`${phase} phase not yet implemented`, { phase }));
}

const PHASE_STUBS: Record<PhaseName, PhaseHandler> = {
	"rfc-draft": runRfcDraftPhase,
	"draft-polish": makeStub("draft-polish"),
	plan: makeStub("plan"),
	execute: makeStub("execute"),
	handoff: makeStub("handoff"),
};

// --- Public API ---

export interface WorkflowOrchestratorOptions {
	config: ResolvedConfig;
	runtime: AgentRuntime;
	state: StateManager;
	worktree: WorktreeManager;
	messaging: MessagingManager;
	prompts: PromptBuilder;
	/** Defaults to process.cwd(). */
	projectCwd?: string;
	/** TUI live-update callback. */
	onEvent?: OrchestratorEventCallback;
	/** Override phase handlers (used in tests and by phase implementation tickets). */
	phases?: Partial<Record<PhaseName, PhaseHandler>>;
}

/**
 * Central engine that wires all components and drives the end-to-end workflow.
 *
 * Lifecycle:
 *   1. `run(task)` is called by the CLI or TUI.
 *   2. The orchestrator checks SQLite for an incomplete run.  If one exists for
 *      the same task it resumes from the last completed phase; otherwise it
 *      creates a fresh WorkflowRun record.
 *   3. It iterates over PHASE_SEQUENCE, delegating each phase to the
 *      corresponding PhaseHandler registered in `phaseRegistry`.
 *   4. After phases that have an approval gate configured it calls
 *      MessagingManager.requestApproval() and blocks until a response arrives.
 *   5. On any phase error it persists the failure to SQLite, fires a
 *      `phase_failed` notification, and re-throws so the CLI can surface it.
 *
 * Phase handlers are mostly stubs until the remaining phase tickets
 * (SLICEWORKF-15, -16, -23, -25, -28) are merged.  Concrete handlers can
 * be injected via `options.phases` — the same mechanism used by the test suite.
 */
export class WorkflowOrchestrator {
	private readonly config: ResolvedConfig;
	private readonly runtime: AgentRuntime;
	private readonly state: StateManager;
	private readonly worktree: WorktreeManager;
	private readonly messaging: MessagingManager;
	private readonly prompts: PromptBuilder;
	private readonly projectCwd: string;
	private readonly onEvent: OrchestratorEventCallback | undefined;
	private readonly phaseRegistry: Map<PhaseName, PhaseHandler>;

	constructor(options: WorkflowOrchestratorOptions) {
		this.config = options.config;
		this.runtime = options.runtime;
		this.state = options.state;
		this.worktree = options.worktree;
		this.messaging = options.messaging;
		this.prompts = options.prompts;
		this.projectCwd = options.projectCwd ?? process.cwd();
		this.onEvent = options.onEvent;
		this.phaseRegistry = new Map(
			Object.entries({ ...PHASE_STUBS, ...options.phases }) as [PhaseName, PhaseHandler][],
		);
	}

	/**
	 * Start or resume a workflow for the given task description.
	 *
	 * On entry the orchestrator checks for an existing incomplete run in SQLite.
	 * If one is found for the same task it resumes from the first non-completed
	 * phase; if one is found for a *different* task it throws so the caller can
	 * inform the user before proceeding.
	 *
	 * The method resolves when all phases have completed successfully, or when
	 * the run is cancelled at an approval gate.  It throws on phase error.
	 */
	async run(task: string): Promise<void> {
		let { run, resumeCtx } = this.resolveOrCreateRun(task);
		run = this.state.runs.update(run.id, { status: "running" });

		let currentPhase: PhaseName = _resolveStartingPhase(resumeCtx);

		try {
			while (true) {
				const outcome = await this.runPhaseWithGate(run, currentPhase, resumeCtx);
				run = this.state.runs.get(run.id) ?? run; // refresh after updates inside runPhaseWithGate
				if (outcome === "stop") {
					return;
				}
				if (outcome === "repeat") {
					continue;
				}
				const nextPhase = this.resolveNextPhase(currentPhase);
				if (nextPhase === null) {
					break;
				}
				currentPhase = nextPhase;
			}

			run = this.state.runs.update(run.id, { status: "completed" });
			const { totalCostUsd } = this.state.getRunCostSummary(run.id);
			this.emitEvent({ type: "workflow_completed", runId: run.id, totalCostUsd });
		} catch (error) {
			if (!(error instanceof PhaseError)) {
				this.handleUnexpectedRunError(run.id, error);
			}
			throw error;
		}
	}

	private handleUnexpectedRunError(runId: string, error: unknown): void {
		const current = this.state.runs.get(runId);
		if (current && (current.status === "running" || current.status === "awaiting_approval")) {
			this.state.runs.update(runId, { status: "failed" });
		}
		this.emitEvent({ type: "workflow_failed", runId, error: toErrorMessage(error) });
	}

	/** Returns { run, resumeCtx } — either a fresh run or the existing incomplete one. */
	private resolveOrCreateRun(task: string): {
		run: WorkflowRun;
		resumeCtx: ResumeContext | undefined;
	} {
		const incomplete = this.state.runs.getLastIncomplete();
		if (!incomplete) {
			const run = this.state.runs.create({
				taskDescription: task,
				slug: slugify(task),
				status: "pending",
				currentPhase: null,
				baseBranch: "main",
				workingBranch: null,
			});
			return { run, resumeCtx: undefined };
		}

		if (incomplete.taskDescription !== task) {
			throw new StateError(
				`A run for a different task is already in progress: "${incomplete.taskDescription}". Complete or cancel it before starting a new task.`,
				{ phase: undefined },
			);
		}

		return { run: incomplete, resumeCtx: this.state.getResumeContext(incomplete.id) };
	}

	/**
	 * Runs a single phase and handles its approval gate.
	 * Returns whether the workflow should advance, repeat the phase, or stop.
	 */
	private async runPhaseWithGate(
		run: WorkflowRun,
		phase: PhaseName,
		resumeCtx: ResumeContext | undefined,
	): Promise<GateOutcome> {
		if (!_canTransition(run.currentPhase, phase)) {
			throw new StateError(`Invalid phase transition: ${run.currentPhase ?? "null"} → ${phase}`, {
				phase,
			});
		}

		this.state.runs.update(run.id, { currentPhase: phase });
		const result = await this.runPhase(run, phase, resumeCtx);

		if (result.status === "failed") {
			this.state.runs.update(run.id, { status: "failed" });
			this.emitEvent({
				type: "workflow_failed",
				runId: run.id,
				error: result.error ?? "unknown error",
			});
			throw new PhaseError(result.error ?? `Phase ${phase} failed`, { phase });
		}

		// Approval gate: only after completed (not skipped) phases that have a gate configured
		const gateKey = APPROVAL_GATE_MAP[phase];
		if (result.status === "completed" && gateKey && this.config.approvalGates[gateKey]) {
			return this.runApprovalGate(run, phase, result.output);
		}

		return "advance";
	}

	/**
	 * Handles an approval gate after a completed phase.
	 * Returns whether the workflow should advance, repeat the phase, or stop.
	 */
	private async runApprovalGate(
		run: WorkflowRun,
		phase: PhaseName,
		artifactHint: string | null,
	): Promise<GateOutcome> {
		const decision = await this.handleApprovalGate(run, phase, artifactHint);
		if (decision === "approved") {
			return "advance";
		}

		if (decision === "request_changes") {
			return "repeat";
		}

		const reason = `Rejected at ${phase} approval gate`;

		this.state.runs.update(run.id, { status: "cancelled" });
		this.emitEvent({ type: "workflow_failed", runId: run.id, error: reason });
		return "stop";
	}

	/**
	 * Execute a single phase:
	 *   1. Create a PhaseRecord in SQLite with status "running".
	 *   2. Build a PhaseContext and call the registered handler.
	 *   3. Persist the result (status, cost, duration, error) to the record.
	 *   4. Emit the appropriate event (phase_completed / phase_skipped).
	 *
	 * On handler error, delegates to handlePhaseError before re-throwing so
	 * the SQLite record and events are always up to date.
	 */
	private async runPhase(
		run: WorkflowRun,
		phase: PhaseName,
		resumeCtx: ResumeContext | undefined,
	): Promise<PhaseResult> {
		const now = new Date().toISOString();
		const phaseRecord = this.state.phases.create({
			runId: run.id,
			phase,
			status: "running",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			error: null,
			startedAt: now,
			endedAt: null,
		});

		this.emitEvent({ type: "phase_started", runId: run.id, phase });

		const ctx = this.buildPhaseContext(run, phase, resumeCtx);
		const handler = this.phaseRegistry.get(phase);
		if (!handler) {
			throw new PhaseError(`No handler registered for phase: ${phase}`, { phase });
		}

		let result: PhaseResult;
		try {
			result = await handler(ctx);
		} catch (error) {
			await this.handlePhaseError(run, phase, phaseRecord.id, error);
			throw error;
		}

		this.state.phases.update(phaseRecord.id, {
			status: result.status,
			agentSessionId: result.agentSessionId,
			costUsd: result.costUsd,
			durationMs: result.durationMs,
			error: result.error,
			endedAt: new Date().toISOString(),
		});

		if (result.status === "skipped") {
			this.emitEvent({ type: "phase_skipped", runId: run.id, phase });
		} else if (result.status === "completed") {
			this.emitEvent({
				type: "phase_completed",
				runId: run.id,
				phase,
				costUsd: result.costUsd,
				durationMs: result.durationMs,
			});
		}
		// "failed" is emitted in handlePhaseError

		return result;
	}

	/**
	 * Send an approval request via MessagingManager and wait for a response.
	 * The artifact path is taken from the phase result output when available;
	 * otherwise a default path is derived from the slug and phase name.
	 * The response is logged to the notifications table regardless of decision.
	 */
	private async handleApprovalGate(
		run: WorkflowRun,
		phase: PhaseName,
		artifactPath: string | null,
	): Promise<ApprovalDecision> {
		const resolvedArtifactPath =
			artifactPath ??
			join(this.projectCwd, this.config.implementationsDir, run.slug, `${phase}.md`);

		this.emitEvent({
			type: "approval_pending",
			runId: run.id,
			phase,
			artifactPath: resolvedArtifactPath,
		});

		this.state.runs.update(run.id, { status: "awaiting_approval" });
		const approvalRequestLog = this.state.notifications.create({
			runId: run.id,
			channel: "tui",
			eventType: "approval_requested",
			payload: JSON.stringify({ phase, artifactPath: resolvedArtifactPath }),
			userResponse: null,
			sentAt: new Date().toISOString(),
			respondedAt: null,
		});

		const response = await this.messaging.requestApproval({
			runId: run.id,
			phase,
			artifactPath: resolvedArtifactPath,
			content: `Approval required for phase: ${phase}`,
		});

		this.state.runs.update(run.id, { status: "running" });
		this.state.notifications.update(approvalRequestLog.id, {
			userResponse: response.decision,
			respondedAt: response.respondedAt,
		});

		this.state.notifications.create({
			runId: run.id,
			channel: response.channel,
			eventType: "approval_response",
			payload: JSON.stringify({ phase, decision: response.decision, feedback: response.feedback }),
			userResponse: response.decision,
			sentAt: new Date().toISOString(),
			respondedAt: response.respondedAt,
		});

		this.emitEvent({
			type: "approval_resolved",
			runId: run.id,
			phase,
			decision: response.decision,
		});

		return response.decision;
	}

	/**
	 * Record a phase failure and propagate it outward:
	 *   1. Update the PhaseRecord to "failed" with the error message.
	 *   2. Emit a phase_failed event (picked up by the TUI).
	 *   3. Fire a messaging notification (best-effort; errors are swallowed so
	 *      they don't mask the original failure).
	 *   4. Mark the WorkflowRun as "failed" in SQLite.
	 */
	private async handlePhaseError(
		run: WorkflowRun,
		phase: PhaseName,
		phaseRecordId: string,
		error: unknown,
	): Promise<void> {
		const errorMessage = toErrorMessage(error);

		this.state.phases.update(phaseRecordId, {
			status: "failed",
			error: errorMessage,
			endedAt: new Date().toISOString(),
		});

		this.emitEvent({ type: "phase_failed", runId: run.id, phase, error: errorMessage });

		try {
			await this.messaging.notify({
				type: "phase_failed",
				runId: run.id,
				phase,
				error: errorMessage,
			});
		} catch {
			// Messaging failures must not mask the original phase error
		}

		this.state.runs.update(run.id, { status: "failed" });
	}

	/** Assemble the PhaseContext passed to every phase handler. */
	private buildPhaseContext(
		run: WorkflowRun,
		phase: PhaseName,
		resumeCtx: ResumeContext | undefined,
	): PhaseContext {
		return {
			runId: run.id,
			run,
			phase,
			config: this.config,
			runtime: this.runtime,
			state: this.state,
			worktree: this.worktree,
			messaging: this.messaging,
			prompts: this.prompts,
			projectCwd: this.projectCwd,
			implementationsDir: resolve(this.projectCwd, this.config.implementationsDir),
			resumeContext: resumeCtx,
			onEvent: this.onEvent,
		};
	}

	/**
	 * Determine what phase should run after `justCompleted` finishes successfully.
	 * Returns null when the workflow is done (handoff just completed).
	 * Top-level phases always advance linearly through PHASE_SEQUENCE.
	 * Review loops are part of execute internals, not top-level orchestration.
	 */
	private resolveNextPhase(justCompleted: PhaseName): PhaseName | null {
		if (justCompleted === "handoff") {
			return null;
		}
		const idx = PHASE_SEQUENCE.indexOf(justCompleted);
		if (idx < 0 || idx >= PHASE_SEQUENCE.length - 1) {
			return null;
		}
		return PHASE_SEQUENCE[idx + 1];
	}

	/**
	 * Forward an event to the onEvent callback.
	 * Errors thrown by the callback are swallowed — a misbehaving TUI must
	 * never crash the orchestrator.
	 */
	private emitEvent(event: OrchestratorEvent): void {
		try {
			this.onEvent?.(event);
		} catch {
			// TUI errors must never crash the orchestrator
		}
	}
}

export function createWorkflowOrchestrator(
	options: WorkflowOrchestratorOptions,
): WorkflowOrchestrator {
	return new WorkflowOrchestrator(options);
}
