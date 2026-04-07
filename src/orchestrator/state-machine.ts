import type { PhaseName, ResumeContext } from "../state/types";

/**
 * Canonical top-level phase execution order for the happy path.
 * Review and fix iterations are part of execute internals (not top-level phases).
 */
export const PHASE_SEQUENCE: PhaseName[] = [
	"rfc-draft",
	"draft-polish",
	"plan",
	"execute",
	"handoff",
];

/**
 * Phases that may be skipped without breaking the workflow.
 * Phase handlers signal a skip by returning { status: "skipped" }.
 * This set is an informational hint for callers (e.g., CLI flags, TUI).
 */
export const SKIPPABLE_PHASES: ReadonlySet<PhaseName> = new Set<PhaseName>(["draft-polish"]);

/**
 * Explicit transition graph.
 * Each entry lists every top-level phase that may follow the key phase.
 * Same-phase (resume re-run) is always valid and is handled separately in canTransition.
 */
const VALID_TRANSITIONS: Readonly<Record<string, ReadonlySet<PhaseName>>> = {
	start: new Set<PhaseName>(["rfc-draft"]),
	"rfc-draft": new Set<PhaseName>(["draft-polish"]),
	"draft-polish": new Set<PhaseName>(["plan"]),
	plan: new Set<PhaseName>(["execute"]),
	execute: new Set<PhaseName>(["handoff"]),
	handoff: new Set<PhaseName>([]),
};

/**
 * Returns true when transitioning from `from` to `to` is a valid move.
 * Rules encoded in VALID_TRANSITIONS plus:
 *   - null → "rfc-draft"  (fresh workflow start, represented as "start" in the map)
 *   - phase → same phase  (re-running a failed or partial phase on resume)
 */
export function canTransition(from: PhaseName | null, to: PhaseName): boolean {
	if (from === to) {
		return true; // resume re-run of same phase is always valid
	}
	const key = from === null ? "start" : from;
	return (VALID_TRANSITIONS[key] ?? new Set()).has(to);
}

/**
 * Returns the phase to start from when resuming an interrupted run.
 * Uses run.currentPhase as the authoritative source — the orchestrator
 * always writes currentPhase before executing a phase, so it reflects
 * exactly where top-level execution stopped.
 *
 * Falls back to the first phase only for brand-new runs (currentPhase = null).
 */
export function resolveStartingPhase(resumeCtx: ResumeContext | undefined): PhaseName {
	if (!resumeCtx) {
		return PHASE_SEQUENCE[0];
	}
	return resumeCtx.run.currentPhase ?? PHASE_SEQUENCE[0];
}

/**
 * Type guard that checks whether a string value is a recognised PhaseName.
 */
export function isValidPhase(value: string): value is PhaseName {
	return (PHASE_SEQUENCE as string[]).includes(value);
}
