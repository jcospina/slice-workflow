import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { type SnakeRow, assertFound } from "../helpers";
import type { CreateReviewResult, ReviewResult } from "../types";

function mapRow(row: SnakeRow): ReviewResult {
	return {
		id: row.id as string,
		runId: row.run_id as string,
		sliceIndex: row.slice_index as number,
		iteration: row.iteration as number,
		verdict: row.verdict as ReviewResult["verdict"],
		confidence: row.confidence as number,
		findings: row.findings as string,
		summary: row.summary as string,
		reviewerSessionId: (row.reviewer_session_id as string) ?? null,
		costUsd: (row.cost_usd as number) ?? null,
		createdAt: row.created_at as string,
	};
}

export class ReviewResultRepo {
	private db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	create(input: CreateReviewResult): ReviewResult {
		const id = nanoid(12);
		const now = new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO review_results (id, run_id, slice_index, iteration, verdict, confidence, findings, summary, reviewer_session_id, cost_usd, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.runId,
				input.sliceIndex,
				input.iteration,
				input.verdict,
				input.confidence,
				input.findings,
				input.summary,
				input.reviewerSessionId,
				input.costUsd,
				now,
			);
		return assertFound(this.get(id), "Review result", id);
	}

	get(id: string): ReviewResult | undefined {
		const row = this.db.prepare("SELECT * FROM review_results WHERE id = ?").get(id) as
			| SnakeRow
			| undefined;
		return row ? mapRow(row) : undefined;
	}

	listBySlice(runId: string, sliceIndex: number): ReviewResult[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM review_results WHERE run_id = ? AND slice_index = ? ORDER BY iteration ASC",
			)
			.all(runId, sliceIndex) as SnakeRow[];
		return rows.map(mapRow);
	}

	getLatest(runId: string, sliceIndex: number): ReviewResult | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM review_results WHERE run_id = ? AND slice_index = ? ORDER BY iteration DESC LIMIT 1",
			)
			.get(runId, sliceIndex) as SnakeRow | undefined;
		return row ? mapRow(row) : undefined;
	}

	listByRun(runId: string): ReviewResult[] {
		const rows = this.db
			.prepare("SELECT * FROM review_results WHERE run_id = ? ORDER BY slice_index, iteration")
			.all(runId) as SnakeRow[];
		return rows.map(mapRow);
	}
}
