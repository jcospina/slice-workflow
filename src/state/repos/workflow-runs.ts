import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { type SnakeRow, assertFound } from "../helpers";
import type { CreateWorkflowRun, UpdateWorkflowRun, WorkflowRun, WorkflowStatus } from "../types";

function mapRow(row: SnakeRow): WorkflowRun {
	return {
		id: row.id as string,
		taskDescription: row.task_description as string,
		slug: row.slug as string,
		status: row.status as WorkflowRun["status"],
		currentPhase: (row.current_phase as WorkflowRun["currentPhase"]) ?? null,
		baseBranch: row.base_branch as string,
		workingBranch: (row.working_branch as string) ?? null,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

export class WorkflowRunRepo {
	private db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	create(input: CreateWorkflowRun): WorkflowRun {
		const id = nanoid(12);
		const now = new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO workflow_runs (id, task_description, slug, status, current_phase, base_branch, working_branch, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.taskDescription,
				input.slug,
				input.status,
				input.currentPhase,
				input.baseBranch,
				input.workingBranch,
				now,
				now,
			);
		return assertFound(this.get(id), "Workflow run", id);
	}

	get(id: string): WorkflowRun | undefined {
		const row = this.db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id) as
			| SnakeRow
			| undefined;
		return row ? mapRow(row) : undefined;
	}

	getBySlug(slug: string): WorkflowRun | undefined {
		const row = this.db
			.prepare("SELECT * FROM workflow_runs WHERE slug = ? ORDER BY rowid DESC LIMIT 1")
			.get(slug) as SnakeRow | undefined;
		return row ? mapRow(row) : undefined;
	}

	update(id: string, updates: UpdateWorkflowRun): WorkflowRun {
		const fields: string[] = [];
		const values: unknown[] = [];

		if (updates.status !== undefined) {
			fields.push("status = ?");
			values.push(updates.status);
		}
		if (updates.currentPhase !== undefined) {
			fields.push("current_phase = ?");
			values.push(updates.currentPhase);
		}
		if (updates.workingBranch !== undefined) {
			fields.push("working_branch = ?");
			values.push(updates.workingBranch);
		}

		if (fields.length === 0) {
			return assertFound(this.get(id), "Workflow run", id);
		}

		fields.push("updated_at = ?");
		values.push(new Date().toISOString());
		values.push(id);

		const result = this.db
			.prepare(`UPDATE workflow_runs SET ${fields.join(", ")} WHERE id = ?`)
			.run(...values);

		if (result.changes === 0) {
			throw new Error(`Workflow run not found: ${id}`);
		}

		return assertFound(this.get(id), "Workflow run", id);
	}

	list(status?: WorkflowStatus): WorkflowRun[] {
		if (status) {
			const rows = this.db
				.prepare("SELECT * FROM workflow_runs WHERE status = ? ORDER BY created_at DESC")
				.all(status) as SnakeRow[];
			return rows.map(mapRow);
		}
		const rows = this.db
			.prepare("SELECT * FROM workflow_runs ORDER BY created_at DESC")
			.all() as SnakeRow[];
		return rows.map(mapRow);
	}

	getActive(): WorkflowRun | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM workflow_runs WHERE status = 'running' ORDER BY created_at DESC LIMIT 1",
			)
			.get() as SnakeRow | undefined;
		return row ? mapRow(row) : undefined;
	}

	getLastIncomplete(): WorkflowRun | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM workflow_runs WHERE status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1",
			)
			.get() as SnakeRow | undefined;
		return row ? mapRow(row) : undefined;
	}

	getResumable(): WorkflowRun | undefined {
		return this.getLastIncomplete();
	}
}
