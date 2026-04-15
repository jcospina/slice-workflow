import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSliceExecutionContext } from "./slice-context";

describe("buildSliceExecutionContext", () => {
	let root: string;
	let planPath: string;
	let progressPath: string;
	let trackPath: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "slice-context-"));
		const tracksDir = join(root, "tracks");
		await mkdir(tracksDir, { recursive: true });

		planPath = join(root, "demo-slug.md");
		progressPath = join(root, "PROGRESS.md");
		trackPath = join(tracksDir, "01-scaffold.md");

		await writeFile(planPath, "# Plan content");
		await writeFile(progressPath, "# Progress content");
		await writeFile(trackPath, "# Track content");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("reads content from the provided file paths", async () => {
		const ctx = await buildSliceExecutionContext({
			planPath,
			progressPath,
			trackPath,
			implRelDir: "implementations",
			slug: "demo-slug",
			worktreePath: "/worktrees/demo-slug-1",
			cumulativeCostUsd: 0,
			remainingBudgetUsd: null,
			slice: { index: 1, name: "Scaffold" },
		});

		expect(ctx.planDoc).toBe("# Plan content");
		expect(ctx.progressDoc).toBe("# Progress content");
		expect(ctx.trackDoc).toBe("# Track content");
	});

	it("computes correct worktree-relative planDocPath", async () => {
		const ctx = await buildSliceExecutionContext({
			planPath,
			progressPath,
			trackPath,
			implRelDir: "implementations",
			slug: "demo-slug",
			worktreePath: "/worktrees/demo-slug-1",
			cumulativeCostUsd: 0,
			remainingBudgetUsd: null,
			slice: { index: 1, name: "Scaffold" },
		});

		expect(ctx.planDocPath).toBe("implementations/demo-slug/demo-slug.md");
	});

	it("computes correct worktree-relative progressDocPath", async () => {
		const ctx = await buildSliceExecutionContext({
			planPath,
			progressPath,
			trackPath,
			implRelDir: "implementations",
			slug: "demo-slug",
			worktreePath: "/worktrees/demo-slug-1",
			cumulativeCostUsd: 0,
			remainingBudgetUsd: null,
			slice: { index: 1, name: "Scaffold" },
		});

		expect(ctx.progressDocPath).toBe("implementations/demo-slug/PROGRESS.md");
	});

	it("computes correct worktree-relative trackDocPath using basename of trackPath", async () => {
		const ctx = await buildSliceExecutionContext({
			planPath,
			progressPath,
			trackPath,
			implRelDir: "implementations",
			slug: "demo-slug",
			worktreePath: "/worktrees/demo-slug-1",
			cumulativeCostUsd: 0,
			remainingBudgetUsd: null,
			slice: { index: 1, name: "Scaffold" },
		});

		expect(ctx.trackDocPath).toBe("implementations/demo-slug/tracks/01-scaffold.md");
	});

	it("propagates cumulativeCostUsd correctly", async () => {
		const ctx = await buildSliceExecutionContext({
			planPath,
			progressPath,
			trackPath,
			implRelDir: "implementations",
			slug: "demo-slug",
			worktreePath: "/worktrees/demo-slug-1",
			cumulativeCostUsd: 1.23,
			remainingBudgetUsd: null,
			slice: { index: 1, name: "Scaffold" },
		});

		expect(ctx.cumulativeCostUsd).toBe(1.23);
	});

	it("propagates non-null remainingBudgetUsd correctly", async () => {
		const ctx = await buildSliceExecutionContext({
			planPath,
			progressPath,
			trackPath,
			implRelDir: "implementations",
			slug: "demo-slug",
			worktreePath: "/worktrees/demo-slug-1",
			cumulativeCostUsd: 0.5,
			remainingBudgetUsd: 9.5,
			slice: { index: 1, name: "Scaffold" },
		});

		expect(ctx.remainingBudgetUsd).toBe(9.5);
	});

	it("preserves null remainingBudgetUsd", async () => {
		const ctx = await buildSliceExecutionContext({
			planPath,
			progressPath,
			trackPath,
			implRelDir: "implementations",
			slug: "demo-slug",
			worktreePath: "/worktrees/demo-slug-1",
			cumulativeCostUsd: 0,
			remainingBudgetUsd: null,
			slice: { index: 1, name: "Scaffold" },
		});

		expect(ctx.remainingBudgetUsd).toBeNull();
	});

	it("propagates slice index and name", async () => {
		const ctx = await buildSliceExecutionContext({
			planPath,
			progressPath,
			trackPath,
			implRelDir: "implementations",
			slug: "demo-slug",
			worktreePath: "/worktrees/demo-slug-1",
			cumulativeCostUsd: 0,
			remainingBudgetUsd: null,
			slice: { index: 3, name: "Integration" },
		});

		expect(ctx.slice).toEqual({ index: 3, name: "Integration" });
	});

	it("propagates worktreePath", async () => {
		const ctx = await buildSliceExecutionContext({
			planPath,
			progressPath,
			trackPath,
			implRelDir: "implementations",
			slug: "demo-slug",
			worktreePath: "/worktrees/my-worktree",
			cumulativeCostUsd: 0,
			remainingBudgetUsd: null,
			slice: { index: 0, name: "Foundation" },
		});

		expect(ctx.worktreePath).toBe("/worktrees/my-worktree");
	});
});
