import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db";
import { type StateManager, createInMemoryStateManager, createStateManager } from "./index";
import type { CreateWorkflowRun } from "./types";

// --- Helper to create a run for tests that need one ---

function makeRun(overrides?: Partial<CreateWorkflowRun>): CreateWorkflowRun {
	return {
		taskDescription: "Test task",
		slug: "test-task",
		status: "pending",
		currentPhase: null,
		baseBranch: "main",
		workingBranch: null,
		...overrides,
	};
}

// --- Database setup ---

describe("database setup", () => {
	it("opens an in-memory database", () => {
		const sm = createInMemoryStateManager();
		expect(sm.db).toBeDefined();
		sm.close();
	});

	it("creates .slice/ directory and database file", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "slice-state-test-"));
		try {
			const dbPath = join(tmpDir, ".slice", "slice.db");
			const sm = createStateManager(dbPath);
			expect(sm.db).toBeDefined();
			sm.close();
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("enables WAL mode", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "slice-wal-test-"));
		try {
			const db = openDatabase(join(tmpDir, "test.db"));
			// biome-ignore lint/style/useNamingConvention: better-sqlite3 pragma returns snake_case keys
			const result = db.pragma("journal_mode") as { journal_mode: string }[];
			expect(result[0].journal_mode).toBe("wal");
			db.close();
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("enables foreign keys", () => {
		const db = openDatabase(":memory:");
		// biome-ignore lint/style/useNamingConvention: better-sqlite3 pragma returns snake_case keys
		const result = db.pragma("foreign_keys") as { foreign_keys: number }[];
		expect(result[0].foreign_keys).toBe(1);
		db.close();
	});

	it("runs migrations idempotently", () => {
		const db = openDatabase(":memory:");
		// Opening again with same db shouldn't error -- test by running migrations again
		const db2 = openDatabase(":memory:");
		expect(db2).toBeDefined();
		db.close();
		db2.close();
	});
});

// --- Migrations ---

describe("migrations", () => {
	let sm: StateManager;

	beforeEach(() => {
		sm = createInMemoryStateManager();
	});

	afterEach(() => {
		sm.close();
	});

	it("creates all expected tables", () => {
		const tables = sm.db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all() as { name: string }[];
		const tableNames = tables.map((t) => t.name);

		expect(tableNames).toContain("workflow_runs");
		expect(tableNames).toContain("phase_records");
		expect(tableNames).toContain("slice_records");
		expect(tableNames).toContain("review_results");
		expect(tableNames).toContain("notification_log");
		expect(tableNames).toContain("_migrations");
	});

	it("creates expected indexes", () => {
		const indexes = sm.db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
			.all() as { name: string }[];
		const indexNames = indexes.map((i) => i.name);

		expect(indexNames).toContain("idx_phase_records_run_id");
		expect(indexNames).toContain("idx_slice_records_run_id");
		expect(indexNames).toContain("idx_review_results_run_id");
		expect(indexNames).toContain("idx_notification_log_run_id");
		expect(indexNames).toContain("idx_workflow_runs_status");
		expect(indexNames).toContain("idx_slice_records_status");
	});

	it("records migration version", () => {
		const row = sm.db.prepare("SELECT MAX(version) as v FROM _migrations").get() as {
			v: number;
		};
		expect(row.v).toBe(2);
	});
});

// --- Workflow Runs ---

describe("workflow runs", () => {
	let sm: StateManager;

	beforeEach(() => {
		sm = createInMemoryStateManager();
	});

	afterEach(() => {
		sm.close();
	});

	it("creates a run with generated ID and timestamps", () => {
		const run = sm.runs.create(makeRun());
		expect(run.id).toHaveLength(12);
		expect(run.taskDescription).toBe("Test task");
		expect(run.slug).toBe("test-task");
		expect(run.status).toBe("pending");
		expect(run.createdAt).toBeTruthy();
		expect(run.updatedAt).toBeTruthy();
	});

	it("retrieves a run by ID", () => {
		const created = sm.runs.create(makeRun());
		const fetched = sm.runs.get(created.id);
		expect(fetched).toEqual(created);
	});

	it("returns undefined for nonexistent ID", () => {
		expect(sm.runs.get("nonexistent")).toBeUndefined();
	});

	it("finds a run by slug", () => {
		sm.runs.create(makeRun({ slug: "my-project" }));
		const found = sm.runs.getBySlug("my-project");
		expect(found?.slug).toBe("my-project");
	});

	it("returns the most recent run for a slug", () => {
		sm.runs.create(makeRun({ slug: "dup", taskDescription: "first" }));
		sm.runs.create(makeRun({ slug: "dup", taskDescription: "second" }));
		const found = sm.runs.getBySlug("dup");
		expect(found?.taskDescription).toBe("second");
	});

	it("updates run status and updatedAt", () => {
		const run = sm.runs.create(makeRun());
		const updated = sm.runs.update(run.id, { status: "running" });
		expect(updated.status).toBe("running");
		expect(updated.updatedAt >= run.updatedAt).toBe(true);
	});

	it("updates currentPhase", () => {
		const run = sm.runs.create(makeRun());
		const updated = sm.runs.update(run.id, { currentPhase: "rfc-draft" });
		expect(updated.currentPhase).toBe("rfc-draft");
	});

	it("throws when updating nonexistent run", () => {
		expect(() => sm.runs.update("nope", { status: "running" })).toThrow("Workflow run not found");
	});

	it("lists all runs", () => {
		sm.runs.create(makeRun({ slug: "a" }));
		sm.runs.create(makeRun({ slug: "b" }));
		expect(sm.runs.list()).toHaveLength(2);
	});

	it("filters runs by status", () => {
		sm.runs.create(makeRun({ status: "pending" }));
		sm.runs.create(makeRun({ status: "running" }));
		sm.runs.create(makeRun({ status: "completed" }));
		expect(sm.runs.list("running")).toHaveLength(1);
		expect(sm.runs.list("pending")).toHaveLength(1);
	});

	it("getActiveRun returns running run", () => {
		sm.runs.create(makeRun({ status: "pending", slug: "a" }));
		sm.runs.create(makeRun({ status: "running", slug: "b" }));
		const active = sm.runs.getActive();
		expect(active?.slug).toBe("b");
	});

	it("getActiveRun returns awaiting_approval run when waiting for human response", () => {
		sm.runs.create(makeRun({ status: "pending", slug: "a" }));
		sm.runs.create(makeRun({ status: "awaiting_approval", slug: "waiting" }));
		const active = sm.runs.getActive();
		expect(active?.slug).toBe("waiting");
	});

	it("getActiveRun returns undefined when none active", () => {
		sm.runs.create(makeRun({ status: "completed" }));
		expect(sm.runs.getActive()).toBeUndefined();
	});

	it("getLastIncompleteRun finds pending/running/awaiting_approval", () => {
		sm.runs.create(makeRun({ status: "completed", slug: "done" }));
		sm.runs.create(makeRun({ status: "pending", slug: "todo" }));
		sm.runs.create(makeRun({ status: "awaiting_approval", slug: "waiting" }));
		const incomplete = sm.runs.getLastIncomplete();
		expect(incomplete?.slug).toBe("waiting");
	});
});

// --- Phase Records ---

describe("phase records", () => {
	let sm: StateManager;
	let runId: string;

	beforeEach(() => {
		sm = createInMemoryStateManager();
		runId = sm.runs.create(makeRun()).id;
	});

	afterEach(() => {
		sm.close();
	});

	it("creates a phase with generated ID", () => {
		const phase = sm.phases.create({
			runId,
			phase: "rfc-draft",
			status: "pending",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		expect(phase.id).toHaveLength(12);
		expect(phase.phase).toBe("rfc-draft");
		expect(phase.runId).toBe(runId);
	});

	it("retrieves phases by run", () => {
		sm.phases.create({
			runId,
			phase: "rfc-draft",
			status: "completed",
			agentSessionId: null,
			costUsd: 0.5,
			durationMs: 3000,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		sm.phases.create({
			runId,
			phase: "plan",
			status: "running",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		const phases = sm.phases.listByRun(runId);
		expect(phases).toHaveLength(2);
		expect(phases[0].phase).toBe("rfc-draft");
		expect(phases[1].phase).toBe("plan");
	});

	it("updates phase status and cost", () => {
		const phase = sm.phases.create({
			runId,
			phase: "rfc-draft",
			status: "running",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			error: null,
			startedAt: new Date().toISOString(),
			endedAt: null,
		});
		const updated = sm.phases.update(phase.id, {
			status: "completed",
			costUsd: 1.23,
			durationMs: 45000,
			endedAt: new Date().toISOString(),
		});
		expect(updated.status).toBe("completed");
		expect(updated.costUsd).toBe(1.23);
		expect(updated.durationMs).toBe(45000);
		expect(updated.endedAt).toBeTruthy();
	});

	it("getCurrentPhase returns running phase", () => {
		sm.phases.create({
			runId,
			phase: "rfc-draft",
			status: "completed",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		sm.phases.create({
			runId,
			phase: "plan",
			status: "running",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		const current = sm.phases.getCurrent(runId);
		expect(current?.phase).toBe("plan");
	});

	it("enforces foreign key on run_id", () => {
		expect(() =>
			sm.phases.create({
				runId: "nonexistent",
				phase: "plan",
				status: "pending",
				agentSessionId: null,
				costUsd: null,
				durationMs: null,
				error: null,
				startedAt: null,
				endedAt: null,
			}),
		).toThrow();
	});
});

// --- Slice Records ---

describe("slice records", () => {
	let sm: StateManager;
	let runId: string;

	beforeEach(() => {
		sm = createInMemoryStateManager();
		runId = sm.runs.create(makeRun()).id;
	});

	afterEach(() => {
		sm.close();
	});

	it("creates a slice with generated ID", () => {
		const slice = sm.slices.create({
			runId,
			index: 0,
			name: "foundation",
			status: "pending",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			turnsUsed: null,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		expect(slice.id).toHaveLength(12);
		expect(slice.index).toBe(0);
		expect(slice.name).toBe("foundation");
	});

	it("retrieves slices ordered by index", () => {
		sm.slices.create({
			runId,
			index: 1,
			name: "db-schema",
			status: "pending",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			turnsUsed: null,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		sm.slices.create({
			runId,
			index: 0,
			name: "foundation",
			status: "completed",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			turnsUsed: null,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		const slices = sm.slices.listByRun(runId);
		expect(slices).toHaveLength(2);
		expect(slices[0].index).toBe(0);
		expect(slices[1].index).toBe(1);
	});

	it("finds slice by index", () => {
		sm.slices.create({
			runId,
			index: 2,
			name: "parser",
			status: "pending",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			turnsUsed: null,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		const found = sm.slices.getByIndex(runId, 2);
		expect(found?.name).toBe("parser");
		expect(sm.slices.getByIndex(runId, 99)).toBeUndefined();
	});

	it("getNextPendingSlice returns first pending by index", () => {
		sm.slices.create({
			runId,
			index: 0,
			name: "done",
			status: "completed",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			turnsUsed: null,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		sm.slices.create({
			runId,
			index: 1,
			name: "next",
			status: "pending",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			turnsUsed: null,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		sm.slices.create({
			runId,
			index: 2,
			name: "later",
			status: "pending",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			turnsUsed: null,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		const next = sm.slices.getNextPending(runId);
		expect(next?.name).toBe("next");
		expect(next?.index).toBe(1);
	});

	it("getFailedSlices returns only failed", () => {
		sm.slices.create({
			runId,
			index: 0,
			name: "ok",
			status: "completed",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			turnsUsed: null,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		sm.slices.create({
			runId,
			index: 1,
			name: "broken",
			status: "failed",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			turnsUsed: null,
			error: "compilation error",
			startedAt: null,
			endedAt: null,
		});
		const failed = sm.slices.getFailed(runId);
		expect(failed).toHaveLength(1);
		expect(failed[0].name).toBe("broken");
		expect(failed[0].error).toBe("compilation error");
	});

	it("updates slice status", () => {
		const slice = sm.slices.create({
			runId,
			index: 0,
			name: "test",
			status: "pending",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			turnsUsed: null,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		const updated = sm.slices.update(slice.id, { status: "running", agentSessionId: "sess-123" });
		expect(updated.status).toBe("running");
		expect(updated.agentSessionId).toBe("sess-123");
	});
});

// --- Review Results ---

describe("review results", () => {
	let sm: StateManager;
	let runId: string;

	beforeEach(() => {
		sm = createInMemoryStateManager();
		runId = sm.runs.create(makeRun()).id;
	});

	afterEach(() => {
		sm.close();
	});

	it("creates a review and stores findings as JSON", () => {
		const findings = JSON.stringify([
			{ severity: "major", file: "src/foo.ts", title: "Missing error handling" },
		]);
		const review = sm.reviews.create({
			runId,
			sliceIndex: 0,
			iteration: 1,
			verdict: "FAIL",
			confidence: 0.85,
			findings,
			summary: "Found issues",
			reviewerSessionId: "rev-001",
			costUsd: 0.3,
		});
		expect(review.id).toHaveLength(12);
		expect(review.verdict).toBe("FAIL");
		expect(review.confidence).toBe(0.85);
		expect(JSON.parse(review.findings)).toHaveLength(1);
	});

	it("retrieves reviews by slice ordered by iteration", () => {
		sm.reviews.create({
			runId,
			sliceIndex: 0,
			iteration: 1,
			verdict: "FAIL",
			confidence: 0.8,
			findings: "[]",
			summary: "First review",
			reviewerSessionId: null,
			costUsd: null,
		});
		sm.reviews.create({
			runId,
			sliceIndex: 0,
			iteration: 2,
			verdict: "PASS",
			confidence: 0.95,
			findings: "[]",
			summary: "Second review",
			reviewerSessionId: null,
			costUsd: null,
		});
		const reviews = sm.reviews.listBySlice(runId, 0);
		expect(reviews).toHaveLength(2);
		expect(reviews[0].iteration).toBe(1);
		expect(reviews[1].iteration).toBe(2);
	});

	it("getLatestReview returns highest iteration", () => {
		sm.reviews.create({
			runId,
			sliceIndex: 1,
			iteration: 1,
			verdict: "FAIL",
			confidence: 0.7,
			findings: "[]",
			summary: "",
			reviewerSessionId: null,
			costUsd: null,
		});
		sm.reviews.create({
			runId,
			sliceIndex: 1,
			iteration: 2,
			verdict: "PASS",
			confidence: 0.9,
			findings: "[]",
			summary: "",
			reviewerSessionId: null,
			costUsd: null,
		});
		const latest = sm.reviews.getLatest(runId, 1);
		expect(latest?.iteration).toBe(2);
		expect(latest?.verdict).toBe("PASS");
	});
});

// --- Notification Log ---

describe("notification log", () => {
	let sm: StateManager;
	let runId: string;

	beforeEach(() => {
		sm = createInMemoryStateManager();
		runId = sm.runs.create(makeRun()).id;
	});

	afterEach(() => {
		sm.close();
	});

	it("creates a notification", () => {
		const notif = sm.notifications.create({
			runId,
			channel: "slack",
			eventType: "approval_gate_reached",
			payload: JSON.stringify({ phase: "plan" }),
			userResponse: null,
			sentAt: new Date().toISOString(),
			respondedAt: null,
		});
		expect(notif.id).toHaveLength(12);
		expect(notif.channel).toBe("slack");
		expect(notif.eventType).toBe("approval_gate_reached");
	});

	it("updates notification response", () => {
		const notif = sm.notifications.create({
			runId,
			channel: "telegram",
			eventType: "slice_completed",
			payload: "{}",
			userResponse: null,
			sentAt: new Date().toISOString(),
			respondedAt: null,
		});
		const now = new Date().toISOString();
		const updated = sm.notifications.update(notif.id, {
			userResponse: JSON.stringify({ action: "approved" }),
			respondedAt: now,
		});
		expect(updated.userResponse).toBe(JSON.stringify({ action: "approved" }));
		expect(updated.respondedAt).toBe(now);
	});

	it("retrieves notifications by run", () => {
		sm.notifications.create({
			runId,
			channel: "slack",
			eventType: "slice_completed",
			payload: "{}",
			userResponse: null,
			sentAt: new Date().toISOString(),
			respondedAt: null,
		});
		sm.notifications.create({
			runId,
			channel: "telegram",
			eventType: "workflow_completed",
			payload: "{}",
			userResponse: null,
			sentAt: new Date().toISOString(),
			respondedAt: null,
		});
		const notifs = sm.notifications.listByRun(runId);
		expect(notifs).toHaveLength(2);
	});
});

// --- Resumability ---

describe("resumability", () => {
	let sm: StateManager;

	beforeEach(() => {
		sm = createInMemoryStateManager();
	});

	afterEach(() => {
		sm.close();
	});

	it("getResumableRun finds incomplete run", () => {
		sm.runs.create(makeRun({ status: "completed", slug: "done" }));
		sm.runs.create(makeRun({ status: "running", slug: "active" }));
		sm.runs.create(makeRun({ status: "awaiting_approval", slug: "waiting" }));
		const resumable = sm.runs.getResumable();
		expect(resumable?.slug).toBe("waiting");
	});

	it("getResumableRun returns undefined when all complete", () => {
		sm.runs.create(makeRun({ status: "completed" }));
		sm.runs.create(makeRun({ status: "failed", slug: "f" }));
		expect(sm.runs.getResumable()).toBeUndefined();
	});

	it("getResumeContext returns full context", () => {
		const run = sm.runs.create(makeRun({ status: "running" }));
		sm.phases.create({
			runId: run.id,
			phase: "rfc-draft",
			status: "completed",
			agentSessionId: null,
			costUsd: 0.5,
			durationMs: 5000,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		sm.slices.create({
			runId: run.id,
			index: 0,
			name: "foundation",
			status: "completed",
			agentSessionId: null,
			costUsd: 1.0,
			durationMs: 30000,
			turnsUsed: null,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		sm.reviews.create({
			runId: run.id,
			sliceIndex: 0,
			iteration: 1,
			verdict: "PASS",
			confidence: 0.95,
			findings: "[]",
			summary: "OK",
			reviewerSessionId: null,
			costUsd: 0.1,
		});

		const ctx = sm.getResumeContext(run.id);
		expect(ctx).toBeDefined();
		expect(ctx?.run.id).toBe(run.id);
		expect(ctx?.phases).toHaveLength(1);
		expect(ctx?.slices).toHaveLength(1);
		expect(ctx?.reviews).toHaveLength(1);
	});

	it("getResumeContext returns undefined for nonexistent run", () => {
		expect(sm.getResumeContext("nope")).toBeUndefined();
	});
});

// --- Cost Summary ---

describe("cost summary", () => {
	let sm: StateManager;
	let runId: string;

	beforeEach(() => {
		sm = createInMemoryStateManager();
		runId = sm.runs.create(makeRun()).id;
	});

	afterEach(() => {
		sm.close();
	});

	it("aggregates cost and duration across phases and slices", () => {
		sm.phases.create({
			runId,
			phase: "rfc-draft",
			status: "completed",
			agentSessionId: null,
			costUsd: 0.5,
			durationMs: 5000,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		sm.phases.create({
			runId,
			phase: "plan",
			status: "completed",
			agentSessionId: null,
			costUsd: 0.3,
			durationMs: 3000,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		sm.slices.create({
			runId,
			index: 0,
			name: "s0",
			status: "completed",
			agentSessionId: null,
			costUsd: 2.0,
			durationMs: 60000,
			turnsUsed: null,
			error: null,
			startedAt: null,
			endedAt: null,
		});
		sm.slices.create({
			runId,
			index: 1,
			name: "s1",
			status: "pending",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			turnsUsed: null,
			error: null,
			startedAt: null,
			endedAt: null,
		});

		const summary = sm.getRunCostSummary(runId);
		expect(summary.totalCostUsd).toBeCloseTo(2.8);
		expect(summary.totalDurationMs).toBe(68000);
		expect(summary.slicesCompleted).toBe(1);
		expect(summary.slicesTotal).toBe(2);
	});

	it("returns zeros when no cost data", () => {
		const summary = sm.getRunCostSummary(runId);
		expect(summary.totalCostUsd).toBe(0);
		expect(summary.totalDurationMs).toBe(0);
		expect(summary.slicesCompleted).toBe(0);
		expect(summary.slicesTotal).toBe(0);
	});
});
