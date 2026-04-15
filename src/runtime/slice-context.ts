import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface SliceExecutionContext {
	readonly planDoc: string;
	readonly progressDoc: string;
	readonly trackDoc: string;
	readonly worktreePath: string;
	readonly planDocPath: string; // worktree-relative
	readonly progressDocPath: string; // worktree-relative
	readonly trackDocPath: string; // worktree-relative
	readonly cumulativeCostUsd: number;
	readonly remainingBudgetUsd: number | null;
	readonly slice: { index: number; name: string };
}

export interface BuildSliceContextOptions {
	planPath: string;
	progressPath: string;
	trackPath: string;
	implRelDir: string; // e.g. "implementations" — ctx.config.implementationsDir
	slug: string;
	worktreePath: string;
	cumulativeCostUsd: number;
	remainingBudgetUsd: number | null;
	slice: { index: number; name: string };
}

export async function buildSliceExecutionContext(
	options: BuildSliceContextOptions,
): Promise<SliceExecutionContext> {
	const [planDoc, progressDoc, trackDoc] = await Promise.all([
		readFile(options.planPath, "utf-8"),
		readFile(options.progressPath, "utf-8"),
		readFile(options.trackPath, "utf-8"),
	]);

	const planDocPath = join(options.implRelDir, options.slug, `${options.slug}.md`);
	const progressDocPath = join(options.implRelDir, options.slug, "PROGRESS.md");
	const trackDocPath = join(
		options.implRelDir,
		options.slug,
		"tracks",
		basename(options.trackPath),
	);

	return {
		planDoc,
		progressDoc,
		trackDoc,
		worktreePath: options.worktreePath,
		planDocPath,
		progressDocPath,
		trackDocPath,
		cumulativeCostUsd: options.cumulativeCostUsd,
		remainingBudgetUsd: options.remainingBudgetUsd,
		slice: options.slice,
	};
}
