import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { type SnakeRow, assertFound } from "../helpers";
import type { CreateSliceRecord, SliceRecord, UpdateSliceRecord } from "../types";

function mapRow(row: SnakeRow): SliceRecord {
	return {
		id: row.id as string,
		runId: row.run_id as string,
		index: row.index as number,
		name: row.name as string,
		status: row.status as SliceRecord["status"],
		agentSessionId: (row.agent_session_id as string) ?? null,
		costUsd: (row.cost_usd as number) ?? null,
		durationMs: (row.duration_ms as number) ?? null,
		turnsUsed: (row.turns_used as number) ?? null,
		error: (row.error as string) ?? null,
		startedAt: (row.started_at as string) ?? null,
		endedAt: (row.ended_at as string) ?? null,
		createdAt: row.created_at as string,
	};
}

export class SliceRecordRepo {
	private db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	create(input: CreateSliceRecord): SliceRecord {
		const id = nanoid(12);
		const now = new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO slice_records (id, run_id, "index", name, status, agent_session_id, cost_usd, duration_ms, turns_used, error, started_at, ended_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.runId,
				input.index,
				input.name,
				input.status,
				input.agentSessionId,
				input.costUsd,
				input.durationMs,
				input.turnsUsed,
				input.error,
				input.startedAt,
				input.endedAt,
				now,
			);
		return assertFound(this.get(id), "Slice record", id);
	}

	get(id: string): SliceRecord | undefined {
		const row = this.db.prepare("SELECT * FROM slice_records WHERE id = ?").get(id) as
			| SnakeRow
			| undefined;
		return row ? mapRow(row) : undefined;
	}

	update(id: string, updates: UpdateSliceRecord): SliceRecord {
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
		if (updates.turnsUsed !== undefined) {
			fields.push("turns_used = ?");
			values.push(updates.turnsUsed);
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
			return assertFound(this.get(id), "Slice record", id);
		}

		values.push(id);
		const result = this.db
			.prepare(`UPDATE slice_records SET ${fields.join(", ")} WHERE id = ?`)
			.run(...values);

		if (result.changes === 0) {
			throw new Error(`Slice record not found: ${id}`);
		}

		return assertFound(this.get(id), "Slice record", id);
	}

	listByRun(runId: string): SliceRecord[] {
		const rows = this.db
			.prepare('SELECT * FROM slice_records WHERE run_id = ? ORDER BY "index" ASC')
			.all(runId) as SnakeRow[];
		return rows.map(mapRow);
	}

	getByIndex(runId: string, index: number): SliceRecord | undefined {
		const row = this.db
			.prepare('SELECT * FROM slice_records WHERE run_id = ? AND "index" = ?')
			.get(runId, index) as SnakeRow | undefined;
		return row ? mapRow(row) : undefined;
	}

	getNextPending(runId: string): SliceRecord | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM slice_records WHERE run_id = ? AND status = 'pending' ORDER BY \"index\" ASC LIMIT 1",
			)
			.get(runId) as SnakeRow | undefined;
		return row ? mapRow(row) : undefined;
	}

	getFailed(runId: string): SliceRecord[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM slice_records WHERE run_id = ? AND status = 'failed' ORDER BY \"index\" ASC",
			)
			.all(runId) as SnakeRow[];
		return rows.map(mapRow);
	}
}
