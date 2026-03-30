import type Database from "better-sqlite3";
import { defaultDbPath, openDatabase } from "./db";
import { NotificationLogRepo } from "./repos/notification-log";
import { PhaseRecordRepo } from "./repos/phase-records";
import { ReviewResultRepo } from "./repos/review-results";
import { SliceRecordRepo } from "./repos/slice-records";
import { WorkflowRunRepo } from "./repos/workflow-runs";
import type { ResumeContext, RunCostSummary } from "./types";

export { defaultDbPath, openDatabase } from "./db";
export type * from "./types";

export class StateManager {
	readonly db: Database.Database;
	readonly runs: WorkflowRunRepo;
	readonly phases: PhaseRecordRepo;
	readonly slices: SliceRecordRepo;
	readonly reviews: ReviewResultRepo;
	readonly notifications: NotificationLogRepo;

	constructor(db: Database.Database) {
		this.db = db;
		this.runs = new WorkflowRunRepo(db);
		this.phases = new PhaseRecordRepo(db);
		this.slices = new SliceRecordRepo(db);
		this.reviews = new ReviewResultRepo(db);
		this.notifications = new NotificationLogRepo(db);
	}

	close(): void {
		this.db.close();
	}

	getResumeContext(runId: string): ResumeContext | undefined {
		const run = this.runs.get(runId);
		if (!run) {
			return undefined;
		}

		return {
			run,
			phases: this.phases.listByRun(runId),
			slices: this.slices.listByRun(runId),
			reviews: this.reviews.listByRun(runId),
		};
	}

	getRunCostSummary(runId: string): RunCostSummary {
		const costRow = this.db
			.prepare(
				`SELECT
					COALESCE(SUM(cost_usd), 0) as totalCost,
					COALESCE(SUM(duration_ms), 0) as totalDuration
				 FROM (
					SELECT cost_usd, duration_ms FROM phase_records WHERE run_id = ?
					UNION ALL
					SELECT cost_usd, duration_ms FROM slice_records WHERE run_id = ?
				 )`,
			)
			.get(runId, runId) as { totalCost: number; totalDuration: number };

		const sliceRow = this.db
			.prepare(
				`SELECT
					COUNT(*) as slicesTotal,
					COUNT(CASE WHEN status = 'completed' THEN 1 END) as slicesCompleted
				 FROM slice_records WHERE run_id = ?`,
			)
			.get(runId) as { slicesTotal: number; slicesCompleted: number };

		return {
			totalCostUsd: costRow.totalCost,
			totalDurationMs: costRow.totalDuration,
			slicesCompleted: sliceRow.slicesCompleted,
			slicesTotal: sliceRow.slicesTotal,
		};
	}
}

export function createStateManager(dbPath?: string): StateManager {
	const db = openDatabase(dbPath ?? defaultDbPath());
	return new StateManager(db);
}

export function createInMemoryStateManager(): StateManager {
	const db = openDatabase(":memory:");
	return new StateManager(db);
}
