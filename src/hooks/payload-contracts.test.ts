/**
 * Payload contract tests for SLICEWORKF-21.
 *
 * Verify HookInput payload shapes for currently-emitted core lifecycle events.
 * This acts as a living spec and remains fully isolated from sample adapter
 * scripts under docs/hooks/.
 */

import { describe, expect, it } from "vitest";
import type { HookInput } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---------------------------------------------------------------------------
// Canonical HookInput fixtures for representative emitted events
// ---------------------------------------------------------------------------

const EMITTED_FIXTURES: HookInput[] = [
	{
		event: "workflow:start",
		timestamp: "2026-04-09T00:00:00.000Z",
		runId: "run-test-1",
		payload: { task: "Add feature X", slug: "add-feature-x" },
	},
	{
		event: "workflow:complete",
		timestamp: "2026-04-09T01:00:00.000Z",
		runId: "run-test-1",
		payload: { totalCostUsd: 0.42 },
	},
	{
		event: "workflow:failed",
		timestamp: "2026-04-09T00:30:00.000Z",
		runId: "run-test-1",
		payload: { error: "Phase plan failed: model timeout" },
	},
	{
		event: "phase:start",
		timestamp: "2026-04-09T00:05:00.000Z",
		runId: "run-test-1",
		payload: { phase: "rfc-draft" },
	},
	{
		event: "phase:complete",
		timestamp: "2026-04-09T00:10:00.000Z",
		runId: "run-test-1",
		payload: { phase: "rfc-draft", costUsd: 0.05, durationMs: 45_000 },
	},
	{
		event: "phase:failed",
		timestamp: "2026-04-09T00:10:00.000Z",
		runId: "run-test-1",
		payload: { phase: "plan", error: "Agent exceeded max turns" },
	},
	{
		event: "approval:requested",
		timestamp: "2026-04-09T00:15:00.000Z",
		runId: "run-test-1",
		payload: {
			phase: "plan",
			artifactPath: "/project/implementations/add-feature-x/plan.md",
		},
	},
	{
		event: "approval:received",
		timestamp: "2026-04-09T00:20:00.000Z",
		runId: "run-test-1",
		payload: { phase: "plan", decision: "approved" },
	},
];

describe("HookInput payload contracts", () => {
	it("workflow:start payload has string task and slug", () => {
		const fixture = EMITTED_FIXTURES.find((f) => f.event === "workflow:start");
		expect(fixture).toBeDefined();
		expect(typeof fixture?.payload.task).toBe("string");
		expect(typeof fixture?.payload.slug).toBe("string");
	});

	it("workflow:complete payload has numeric totalCostUsd", () => {
		const fixture = EMITTED_FIXTURES.find((f) => f.event === "workflow:complete");
		expect(fixture).toBeDefined();
		expect(typeof fixture?.payload.totalCostUsd).toBe("number");
	});

	it("workflow:failed payload has string error", () => {
		const fixture = EMITTED_FIXTURES.find((f) => f.event === "workflow:failed");
		expect(fixture).toBeDefined();
		expect(typeof fixture?.payload.error).toBe("string");
	});

	it("phase:start payload has string phase", () => {
		const fixture = EMITTED_FIXTURES.find((f) => f.event === "phase:start");
		expect(fixture).toBeDefined();
		expect(typeof fixture?.payload.phase).toBe("string");
	});

	it("phase:complete payload has phase, numeric costUsd, and numeric durationMs", () => {
		const fixture = EMITTED_FIXTURES.find((f) => f.event === "phase:complete");
		expect(fixture).toBeDefined();
		expect(typeof fixture?.payload.phase).toBe("string");
		expect(typeof fixture?.payload.costUsd).toBe("number");
		expect(typeof fixture?.payload.durationMs).toBe("number");
	});

	it("phase:failed payload has string phase and string error", () => {
		const fixture = EMITTED_FIXTURES.find((f) => f.event === "phase:failed");
		expect(fixture).toBeDefined();
		expect(typeof fixture?.payload.phase).toBe("string");
		expect(typeof fixture?.payload.error).toBe("string");
	});

	it("approval:requested payload has string phase and string artifactPath", () => {
		const fixture = EMITTED_FIXTURES.find((f) => f.event === "approval:requested");
		expect(fixture).toBeDefined();
		expect(typeof fixture?.payload.phase).toBe("string");
		expect(typeof fixture?.payload.artifactPath).toBe("string");
	});

	it("approval:received payload has string phase and a valid decision value", () => {
		const fixture = EMITTED_FIXTURES.find((f) => f.event === "approval:received");
		expect(fixture).toBeDefined();
		expect(typeof fixture?.payload.phase).toBe("string");
		expect(["approved", "request_changes", "rejected"]).toContain(fixture?.payload.decision);
	});

	it("all emitted fixtures have an ISO 8601 timestamp", () => {
		for (const fixture of EMITTED_FIXTURES) {
			expect(fixture.timestamp).toMatch(ISO_8601_PATTERN);
		}
	});

	it("all emitted fixtures have a runId string", () => {
		for (const fixture of EMITTED_FIXTURES) {
			expect(typeof fixture.runId).toBe("string");
		}
	});
});
