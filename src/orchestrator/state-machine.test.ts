import { describe, expect, it } from "vitest";
import type { PhaseRecord, ResumeContext } from "../state/types";
import {
	PHASE_SEQUENCE,
	SKIPPABLE_PHASES,
	canTransition,
	isValidPhase,
	resolveStartingPhase,
} from "./state-machine";

describe("PHASE_SEQUENCE", () => {
	it("contains all six phases in order", () => {
		expect(PHASE_SEQUENCE).toEqual([
			"rfc-draft",
			"draft-polish",
			"plan",
			"execute",
			"review",
			"handoff",
		]);
	});
});

describe("SKIPPABLE_PHASES", () => {
	it("marks draft-polish as skippable", () => {
		expect(SKIPPABLE_PHASES.has("draft-polish")).toBe(true);
	});

	it("does not mark other phases as skippable", () => {
		for (const phase of PHASE_SEQUENCE) {
			if (phase !== "draft-polish") {
				expect(SKIPPABLE_PHASES.has(phase)).toBe(false);
			}
		}
	});
});

describe("canTransition", () => {
	it("allows null → rfc-draft (fresh start)", () => {
		expect(canTransition(null, "rfc-draft")).toBe(true);
	});

	it("disallows null → any phase other than rfc-draft", () => {
		expect(canTransition(null, "draft-polish")).toBe(false);
		expect(canTransition(null, "plan")).toBe(false);
		expect(canTransition(null, "execute")).toBe(false);
		expect(canTransition(null, "review")).toBe(false);
		expect(canTransition(null, "handoff")).toBe(false);
	});

	it("allows sequential forward transitions", () => {
		expect(canTransition("rfc-draft", "draft-polish")).toBe(true);
		expect(canTransition("draft-polish", "plan")).toBe(true);
		expect(canTransition("plan", "execute")).toBe(true);
		expect(canTransition("execute", "review")).toBe(true);
		expect(canTransition("review", "handoff")).toBe(true);
	});

	it("disallows skipping phases", () => {
		expect(canTransition("rfc-draft", "plan")).toBe(false);
		expect(canTransition("rfc-draft", "execute")).toBe(false);
		expect(canTransition("draft-polish", "execute")).toBe(false);
		expect(canTransition("execute", "handoff")).toBe(false);
		expect(canTransition("plan", "review")).toBe(false);
	});

	it("disallows backward transitions", () => {
		expect(canTransition("draft-polish", "rfc-draft")).toBe(false);
		expect(canTransition("handoff", "rfc-draft")).toBe(false);
		expect(canTransition("review", "execute")).toBe(false);
	});

	it("allows same-phase transition (resume re-run)", () => {
		for (const phase of PHASE_SEQUENCE) {
			expect(canTransition(phase, phase)).toBe(true);
		}
	});
});

describe("resolveStartingPhase", () => {
	it("returns rfc-draft when there is no resume context (fresh run)", () => {
		expect(resolveStartingPhase(undefined)).toBe("rfc-draft");
	});

	function makeResumeCtx(phases: Pick<PhaseRecord, "phase" | "status">[]): ResumeContext {
		return {
			run: {} as ResumeContext["run"],
			phases: phases as PhaseRecord[],
			slices: [],
			reviews: [],
		};
	}

	it("returns rfc-draft when no phases are completed", () => {
		expect(resolveStartingPhase(makeResumeCtx([{ phase: "rfc-draft", status: "failed" }]))).toBe(
			"rfc-draft",
		);
	});

	it("returns the first incomplete phase when some phases are completed", () => {
		expect(
			resolveStartingPhase(
				makeResumeCtx([
					{ phase: "rfc-draft", status: "completed" },
					{ phase: "draft-polish", status: "completed" },
				]),
			),
		).toBe("plan");
	});

	it("returns the first phase when all phases are completed (shouldn't normally happen)", () => {
		// find returns undefined → falls back to PHASE_SEQUENCE[0]
		expect(
			resolveStartingPhase(
				makeResumeCtx(PHASE_SEQUENCE.map((phase) => ({ phase, status: "completed" as const }))),
			),
		).toBe("rfc-draft");
	});

	it("skips skipped phases when resolving start (treats them as not completed)", () => {
		// draft-polish is skipped (not completed), so it would be returned — but in
		// practice the orchestrator moves past skipped phases too. This tests the
		// raw resolveStartingPhase behaviour: skipped ≠ completed.
		expect(
			resolveStartingPhase(
				makeResumeCtx([
					{ phase: "rfc-draft", status: "completed" },
					{ phase: "draft-polish", status: "skipped" },
				]),
			),
		).toBe("draft-polish");
	});
});

describe("isValidPhase", () => {
	it("returns true for all valid phase names", () => {
		for (const phase of PHASE_SEQUENCE) {
			expect(isValidPhase(phase)).toBe(true);
		}
	});

	it("returns false for unknown strings", () => {
		expect(isValidPhase("unknown")).toBe(false);
		expect(isValidPhase("")).toBe(false);
		expect(isValidPhase("RFC-DRAFT")).toBe(false);
	});
});
