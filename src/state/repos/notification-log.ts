import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { type SnakeRow, assertFound } from "../helpers";
import type { CreateNotificationLog, NotificationLog, UpdateNotificationLog } from "../types";

function mapRow(row: SnakeRow): NotificationLog {
	return {
		id: row.id as string,
		runId: row.run_id as string,
		channel: row.channel as NotificationLog["channel"],
		eventType: row.event_type as string,
		payload: row.payload as string,
		userResponse: (row.user_response as string) ?? null,
		sentAt: row.sent_at as string,
		respondedAt: (row.responded_at as string) ?? null,
	};
}

export class NotificationLogRepo {
	private db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	create(input: CreateNotificationLog): NotificationLog {
		const id = nanoid(12);
		this.db
			.prepare(
				`INSERT INTO notification_log (id, run_id, channel, event_type, payload, user_response, sent_at, responded_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.runId,
				input.channel,
				input.eventType,
				input.payload,
				input.userResponse,
				input.sentAt,
				input.respondedAt,
			);
		return assertFound(this.get(id), "Notification", id);
	}

	get(id: string): NotificationLog | undefined {
		const row = this.db.prepare("SELECT * FROM notification_log WHERE id = ?").get(id) as
			| SnakeRow
			| undefined;
		return row ? mapRow(row) : undefined;
	}

	update(id: string, updates: UpdateNotificationLog): NotificationLog {
		const fields: string[] = [];
		const values: unknown[] = [];

		if (updates.userResponse !== undefined) {
			fields.push("user_response = ?");
			values.push(updates.userResponse);
		}
		if (updates.respondedAt !== undefined) {
			fields.push("responded_at = ?");
			values.push(updates.respondedAt);
		}

		if (fields.length === 0) {
			return assertFound(this.get(id), "Notification", id);
		}

		values.push(id);
		const result = this.db
			.prepare(`UPDATE notification_log SET ${fields.join(", ")} WHERE id = ?`)
			.run(...values);

		if (result.changes === 0) {
			throw new Error(`Notification not found: ${id}`);
		}

		return assertFound(this.get(id), "Notification", id);
	}

	listByRun(runId: string): NotificationLog[] {
		const rows = this.db
			.prepare("SELECT * FROM notification_log WHERE run_id = ? ORDER BY sent_at ASC")
			.all(runId) as SnakeRow[];
		return rows.map(mapRow);
	}
}
