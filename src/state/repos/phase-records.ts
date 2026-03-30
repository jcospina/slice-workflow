import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { type SnakeRow, assertFound } from "../helpers";
import type { CreatePhaseRecord, PhaseRecord, UpdatePhaseRecord } from "../types";

function mapRow(row: SnakeRow): PhaseRecord {
	return {
		id: row.id as string,
		runId: row.run_id as string,
		phase: row.phase as PhaseRecord["phase"],
		status: row.status as PhaseRecord["status"],
		agentSessionId: (row.agent_session_id as string) ?? null,
		costUsd: (row.cost_usd as number) ?? null,
		durationMs: (row.duration_ms as number) ?? null,
		error: (row.error as string) ?? null,
		startedAt: (row.started_at as string) ?? null,
		endedAt: (row.ended_at as string) ?? null,
		createdAt: row.created_at as string,
	};
}

export class PhaseRecordRepo {
	private db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	create(input: CreatePhaseRecord): PhaseRecord {
		const id = nanoid(12);
		const now = new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO phase_records (id, run_id, phase, status, agent_session_id, cost_usd, duration_ms, error, started_at, ended_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.runId,
				input.phase,
				input.status,
				input.agentSessionId,
				input.costUsd,
				input.durationMs,
				input.error,
				input.startedAt,
				input.endedAt,
				now,
			);
		return assertFound(this.get(id), "Phase record", id);
	}

	get(id: string): PhaseRecord | undefined {
		const row = this.db.prepare("SELECT * FROM phase_records WHERE id = ?").get(id) as
			| SnakeRow
			| undefined;
		return row ? mapRow(row) : undefined;
	}

	update(id: string, updates: UpdatePhaseRecord): PhaseRecord {
		const fields: string[] = [];
		const values: unknown[] = [];

		if (updates.status !== undefined) {
			fields.push("status = ?");
			values.push(updates.status);
		}
		if (updates.agentSessionId !== undefined) {
			fields.push("agent_session_id = ?");
			values.push(updates.agentSessionId);
		}
		if (updates.costUsd !== undefined) {
			fields.push("cost_usd = ?");
			values.push(updates.costUsd);
		}
		if (updates.durationMs !== undefined) {
			fields.push("duration_ms = ?");
			values.push(updates.durationMs);
		}
		if (updates.error !== undefined) {
			fields.push("error = ?");
			values.push(updates.error);
		}
		if (updates.startedAt !== undefined) {
			fields.push("started_at = ?");
			values.push(updates.startedAt);
		}
		if (updates.endedAt !== undefined) {
			fields.push("ended_at = ?");
			values.push(updates.endedAt);
		}

		if (fields.length === 0) {
			return assertFound(this.get(id), "Phase record", id);
		}

		values.push(id);
		const result = this.db
			.prepare(`UPDATE phase_records SET ${fields.join(", ")} WHERE id = ?`)
			.run(...values);

		if (result.changes === 0) {
			throw new Error(`Phase record not found: ${id}`);
		}

		return assertFound(this.get(id), "Phase record", id);
	}

	listByRun(runId: string): PhaseRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM phase_records WHERE run_id = ? ORDER BY created_at ASC")
			.all(runId) as SnakeRow[];
		return rows.map(mapRow);
	}

	getCurrent(runId: string): PhaseRecord | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM phase_records WHERE run_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1",
			)
			.get(runId) as SnakeRow | undefined;
		return row ? mapRow(row) : undefined;
	}
}
