import { describe, expect, it } from "vitest";
import type { PhaseName, ResumeContext } from "../state/types";
import {
	PHASE_SEQUENCE,
	SKIPPABLE_PHASES,
	canTransition,
	isValidPhase,
	resolveStartingPhase,
} from "./state-machine";

// --- Helpers ---

function makeResumeCtx(currentPhase: PhaseName | null = null): ResumeContext {
	return {
		run: { currentPhase } as ResumeContext["run"],
		phases: [],
		slices: [],
		reviews: [],
	};
}

// --- Tests ---

describe("PHASE_SEQUENCE", () => {
	it("contains all five top-level phases in order", () => {
		expect(PHASE_SEQUENCE).toEqual(["rfc-draft", "draft-polish", "plan", "execute", "handoff"]);
	});

	it("does not include review as a top-level phase", () => {
		expect(PHASE_SEQUENCE).not.toContain("review");
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
		expect(canTransition(null, "handoff")).toBe(false);
	});

	it("allows sequential forward transitions", () => {
		expect(canTransition("rfc-draft", "draft-polish")).toBe(true);
		expect(canTransition("draft-polish", "plan")).toBe(true);
		expect(canTransition("plan", "execute")).toBe(true);
		expect(canTransition("execute", "handoff")).toBe(true);
	});

	it("rejects review transitions as top-level moves", () => {
		expect(canTransition("execute", "review" as unknown as PhaseName)).toBe(false);
		expect(canTransition("review" as unknown as PhaseName, "execute")).toBe(false);
		expect(canTransition("review" as unknown as PhaseName, "handoff")).toBe(false);
	});

	it("disallows skipping phases in the forward direction", () => {
		expect(canTransition("rfc-draft", "plan")).toBe(false);
		expect(canTransition("rfc-draft", "execute")).toBe(false);
		expect(canTransition("draft-polish", "execute")).toBe(false);
		expect(canTransition("plan", "handoff")).toBe(false);
	});

	it("disallows backward transitions", () => {
		expect(canTransition("draft-polish", "rfc-draft")).toBe(false);
		expect(canTransition("handoff", "rfc-draft")).toBe(false);
		expect(canTransition("plan", "rfc-draft")).toBe(false);
		expect(canTransition("execute", "plan")).toBe(false);
	});

	it("allows same-phase transition (resume re-run) for every phase", () => {
		for (const phase of PHASE_SEQUENCE) {
			expect(canTransition(phase, phase)).toBe(true);
		}
	});
});

describe("resolveStartingPhase", () => {
	it("returns rfc-draft when there is no resume context (fresh run)", () => {
		expect(resolveStartingPhase(undefined)).toBe("rfc-draft");
	});

	it("returns rfc-draft when currentPhase is null", () => {
		expect(resolveStartingPhase(makeResumeCtx(null))).toBe("rfc-draft");
	});

	it("returns run.currentPhase when set", () => {
		expect(resolveStartingPhase(makeResumeCtx("plan"))).toBe("plan");
		expect(resolveStartingPhase(makeResumeCtx("execute"))).toBe("execute");
		expect(resolveStartingPhase(makeResumeCtx("handoff"))).toBe("handoff");
	});

	it("resumes from execute when top-level execution stops there", () => {
		expect(resolveStartingPhase(makeResumeCtx("execute"))).toBe("execute");
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
		expect(isValidPhase("review")).toBe(false);
		expect(isValidPhase("")).toBe(false);
		expect(isValidPhase("RFC-DRAFT")).toBe(false);
	});
});
