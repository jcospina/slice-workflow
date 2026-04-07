import type { PhaseName, ResumeContext } from "../state/types";

/**
 * Canonical phase execution order.
 * The orchestrator iterates this sequence from the resolved starting phase to completion.
 */
export const PHASE_SEQUENCE: PhaseName[] = [
	"rfc-draft",
	"draft-polish",
	"plan",
	"execute",
	"review",
	"handoff",
];

/**
 * Phases that may be skipped without breaking the workflow.
 * Phase handlers signal a skip by returning { status: "skipped" }.
 * This set is an informational hint for callers (e.g., CLI flags, TUI).
 */
export const SKIPPABLE_PHASES: ReadonlySet<PhaseName> = new Set<PhaseName>(["draft-polish"]);

/**
 * Returns true when transitioning from `from` to `to` is a valid move.
 * Rules:
 *   - null → "rfc-draft"  (fresh workflow start)
 *   - phase → same phase  (re-running a failed or partial phase on resume)
 *   - phase → next phase  (normal forward progression)
 * Everything else is invalid.
 */
export function canTransition(from: PhaseName | null, to: PhaseName): boolean {
	if (from === null) {
		return to === PHASE_SEQUENCE[0];
	}
	if (from === to) {
		return true;
	}
	const fromIdx = PHASE_SEQUENCE.indexOf(from);
	const toIdx = PHASE_SEQUENCE.indexOf(to);
	return toIdx === fromIdx + 1;
}

/**
 * Given the resume context (if any), returns the first phase that has not yet
 * completed. On a fresh run (no resumeCtx) this is always the first phase.
 */
export function resolveStartingPhase(resumeCtx: ResumeContext | undefined): PhaseName {
	if (!resumeCtx) {
		return PHASE_SEQUENCE[0];
	}
	const completed = new Set(
		resumeCtx.phases.filter((p) => p.status === "completed").map((p) => p.phase),
	);
	return PHASE_SEQUENCE.find((p) => !completed.has(p)) ?? PHASE_SEQUENCE[0];
}

/**
 * Type guard that checks whether a string value is a recognised PhaseName.
 */
export function isValidPhase(value: string): value is PhaseName {
	return (PHASE_SEQUENCE as string[]).includes(value);
}
