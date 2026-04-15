import { readFile } from "node:fs/promises";
import { DEFAULT_CONTEXT_BUDGET_CHARS, type PromptContextFiles } from "./types";

export interface ContextBlockResult {
	text: string;
	charCount: number;
	maxChars: number;
}

export interface BuildContextBlockOptions {
	files: PromptContextFiles;
	maxChars?: number;
}

export class ContextBudgetExceededError extends Error {
	readonly maxChars: number;
	readonly actualChars: number;

	constructor(maxChars: number, actualChars: number) {
		super(
			`Context block exceeds budget: ${actualChars} characters (max ${maxChars}). Reduce context size before running this prompt.`,
		);
		this.name = "ContextBudgetExceededError";
		this.maxChars = maxChars;
		this.actualChars = actualChars;
	}
}

export async function buildContextBlock(
	options: BuildContextBlockOptions,
): Promise<ContextBlockResult> {
	const maxChars = options.maxChars ?? DEFAULT_CONTEXT_BUDGET_CHARS;
	const files = options.files;

	const [planDoc, progressDoc, currentTrackDoc] = await Promise.all([
		readRequiredFile(files.planPath, "plan document"),
		readRequiredFile(files.progressPath, "PROGRESS.md"),
		readRequiredFile(files.currentTrackPath, "current track file"),
	]);

	const sections = [
		"Context Rules:",
		"- This block contains exactly three files: plan doc, PROGRESS.md, and current track file.",
		"- Do not read previous track files for historical context; use PROGRESS.md for accumulated decisions.",
		"",
		"=== PLAN DOCUMENT ===",
		planDoc,
		"=== END PLAN DOCUMENT ===",
		"",
		"=== PROGRESS DOCUMENT ===",
		progressDoc,
		"=== END PROGRESS DOCUMENT ===",
		"",
		"=== CURRENT TRACK FILE ===",
		currentTrackDoc,
		"=== END CURRENT TRACK FILE ===",
	];

	const text = sections.join("\n");
	const charCount = text.length;

	if (charCount > maxChars) {
		throw new ContextBudgetExceededError(maxChars, charCount);
	}

	return { text, charCount, maxChars };
}

export function buildContextBlockFromContent(
	content: { planDoc: string; progressDoc: string; trackDoc: string },
	maxChars?: number,
): ContextBlockResult {
	const max = maxChars ?? DEFAULT_CONTEXT_BUDGET_CHARS;

	const sections = [
		"Context Rules:",
		"- This block contains exactly three files: plan doc, PROGRESS.md, and current track file.",
		"- Do not read previous track files for historical context; use PROGRESS.md for accumulated decisions.",
		"",
		"=== PLAN DOCUMENT ===",
		content.planDoc,
		"=== END PLAN DOCUMENT ===",
		"",
		"=== PROGRESS DOCUMENT ===",
		content.progressDoc,
		"=== END PROGRESS DOCUMENT ===",
		"",
		"=== CURRENT TRACK FILE ===",
		content.trackDoc,
		"=== END CURRENT TRACK FILE ===",
	];

	const text = sections.join("\n");
	const charCount = text.length;

	if (charCount > max) {
		throw new ContextBudgetExceededError(max, charCount);
	}

	return { text, charCount, maxChars: max };
}

async function readRequiredFile(path: string, label: string): Promise<string> {
	try {
		return await readFile(path, "utf-8");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read ${label} at '${path}': ${reason}`);
	}
}
