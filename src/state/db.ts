import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations";

export function openDatabase(dbPath: string): Database.Database {
	if (dbPath !== ":memory:") {
		mkdirSync(dirname(dbPath), { recursive: true });
	}

	const db = new Database(dbPath);

	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	db.pragma("busy_timeout = 5000");
	db.pragma("synchronous = NORMAL");

	runMigrations(db);

	return db;
}

export function defaultDbPath(cwd: string = process.cwd()): string {
	return join(cwd, ".slice", "slice.db");
}
