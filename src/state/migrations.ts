import type Database from "better-sqlite3";

interface Migration {
	version: number;
	description: string;
	up: string;
}

const migrations: Migration[] = [
	{
		version: 1,
		description: "Initial schema",
		up: `
			CREATE TABLE workflow_runs (
				id TEXT PRIMARY KEY,
				task_description TEXT NOT NULL,
				slug TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				current_phase TEXT,
				base_branch TEXT NOT NULL,
				working_branch TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			CREATE TABLE phase_records (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
				phase TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				agent_session_id TEXT,
				cost_usd REAL,
				duration_ms INTEGER,
				error TEXT,
				started_at TEXT,
				ended_at TEXT,
				created_at TEXT NOT NULL
			);

			CREATE TABLE slice_records (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
				"index" INTEGER NOT NULL,
				name TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				agent_session_id TEXT,
				cost_usd REAL,
				duration_ms INTEGER,
				error TEXT,
				started_at TEXT,
				ended_at TEXT,
				created_at TEXT NOT NULL
			);

			CREATE TABLE review_results (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
				slice_index INTEGER NOT NULL,
				iteration INTEGER NOT NULL,
				verdict TEXT NOT NULL,
				confidence REAL NOT NULL,
				findings TEXT NOT NULL DEFAULT '[]',
				summary TEXT NOT NULL DEFAULT '',
				reviewer_session_id TEXT,
				cost_usd REAL,
				created_at TEXT NOT NULL
			);

			CREATE TABLE notification_log (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
				channel TEXT NOT NULL,
				event_type TEXT NOT NULL,
				payload TEXT NOT NULL DEFAULT '{}',
				user_response TEXT,
				sent_at TEXT NOT NULL,
				responded_at TEXT
			);

			CREATE INDEX idx_phase_records_run_id ON phase_records(run_id);
			CREATE INDEX idx_slice_records_run_id ON slice_records(run_id);
			CREATE INDEX idx_review_results_run_id ON review_results(run_id);
			CREATE INDEX idx_notification_log_run_id ON notification_log(run_id);
			CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);
			CREATE INDEX idx_slice_records_status ON slice_records(status);
		`,
	},
];

export function runMigrations(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS _migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	const row = db.prepare("SELECT MAX(version) as maxVersion FROM _migrations").get() as
		| { maxVersion: number | null }
		| undefined;
	const currentVersion = row?.maxVersion ?? 0;

	const pending = migrations.filter((m) => m.version > currentVersion);
	if (pending.length === 0) {
		return;
	}

	const applyMigration = db.transaction((migration: Migration) => {
		db.exec(migration.up);
		db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(migration.version);
	});

	for (const migration of pending) {
		applyMigration(migration);
	}
}
