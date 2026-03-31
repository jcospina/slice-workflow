import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const FILE_REFERENCE_EXCLUDED_DIRS = [".git", "node_modules", "dist", "build"] as const;

export interface ActiveFileReference {
	readonly query: string;
	readonly tokenStart: number;
	readonly tokenEnd: number;
}

export interface FileReferenceSuppression {
	readonly row: number;
	readonly tokenStart: number;
	readonly query: string;
}

export interface FileReferenceViewState {
	readonly query: string;
	readonly matches: readonly string[];
	readonly highlightedIndex: number;
}

const DEFAULT_FILE_REFERENCE_LIMIT = 5;
const WHITESPACE_RE = /\s/;

function isWhitespace(char: string | undefined): boolean {
	return char !== undefined && WHITESPACE_RE.test(char);
}

function isBoundaryBefore(line: string, index: number): boolean {
	return index === 0 || isWhitespace(line[index - 1]);
}

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

function findTokenEnd(line: string, start: number): number {
	let end = start + 1;
	while (end < line.length && !isWhitespace(line[end])) {
		end += 1;
	}
	return end;
}

function crawlWorkspace(root: string, directory: string): string[] {
	const entries = readdirSync(directory, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const entryPath = join(directory, entry.name);

		if (entry.isDirectory()) {
			if (
				FILE_REFERENCE_EXCLUDED_DIRS.includes(
					entry.name as (typeof FILE_REFERENCE_EXCLUDED_DIRS)[number],
				)
			) {
				continue;
			}
			files.push(...crawlWorkspace(root, entryPath));
			continue;
		}

		if (entry.isFile()) {
			const relativePath = relative(root, entryPath);
			if (relativePath.length > 0) {
				files.push(toPosixPath(relativePath));
			}
		}
	}

	return files;
}

function clampCursor(line: string, cursorCol: number): number {
	return Math.max(0, Math.min(cursorCol, line.length));
}

function finalizeInsertedReference(
	line: string,
	cursorCol: number,
): { line: string; cursorCol: number } {
	const nextChar = line[cursorCol];
	if (nextChar === undefined) {
		return { line: `${line} `, cursorCol: cursorCol + 1 };
	}
	if (isWhitespace(nextChar)) {
		return { line, cursorCol: cursorCol + 1 };
	}
	return {
		line: `${line.slice(0, cursorCol)} ${line.slice(cursorCol)}`,
		cursorCol: cursorCol + 1,
	};
}

export function listWorkspaceFiles(root: string): string[] {
	try {
		return crawlWorkspace(root, root);
	} catch {
		return [];
	}
}

export function findActiveFileReference(
	line: string,
	cursorCol: number,
): ActiveFileReference | null {
	const cursor = clampCursor(line, cursorCol);
	if (cursor === 0) {
		return null;
	}

	for (let index = cursor - 1; index >= 0; index -= 1) {
		const char = line[index];
		if (isWhitespace(char)) {
			return null;
		}
		if (char !== "@") {
			continue;
		}
		if (!isBoundaryBefore(line, index)) {
			continue;
		}

		const tokenEnd = findTokenEnd(line, index);
		if (cursor > tokenEnd) {
			return null;
		}

		return {
			query: line.slice(index + 1, cursor),
			tokenStart: index,
			tokenEnd,
		};
	}

	return null;
}

export function filterFileReferences(
	files: readonly string[],
	query: string,
	limit = DEFAULT_FILE_REFERENCE_LIMIT,
): string[] {
	const normalizedQuery = query.trim().toLowerCase();
	const cappedLimit = Math.max(0, limit);

	if (normalizedQuery.length === 0) {
		return files.slice(0, cappedLimit);
	}

	return files.filter((file) => file.toLowerCase().includes(normalizedQuery)).slice(0, cappedLimit);
}

export function formatFileReference(path: string): string {
	const normalizedPath = path.split("\\").join("/");
	return normalizedPath.includes(" ") ? `@"${normalizedPath}"` : `@${normalizedPath}`;
}

export function isFileReferenceSuppressed(
	reference: ActiveFileReference | null,
	row: number,
	suppression: FileReferenceSuppression | null,
): boolean {
	if (!(reference && suppression)) {
		return false;
	}

	return (
		suppression.row === row &&
		suppression.tokenStart === reference.tokenStart &&
		reference.query.startsWith(suppression.query)
	);
}

export function resolveFileReferenceViewState(
	files: readonly string[],
	line: string,
	cursorCol: number,
	highlightedIndex: number,
	limit = DEFAULT_FILE_REFERENCE_LIMIT,
): FileReferenceViewState | null {
	const activeReference = findActiveFileReference(line, cursorCol);

	if (!activeReference) {
		return null;
	}

	const matches = filterFileReferences(files, activeReference.query, limit);

	return {
		query: activeReference.query,
		matches,
		highlightedIndex: matches.length === 0 ? 0 : Math.min(highlightedIndex, matches.length - 1),
	};
}

export function insertFileReference(
	line: string,
	cursorCol: number,
	path: string,
): { line: string; cursorCol: number } {
	const reference = formatFileReference(path);
	const cursor = clampCursor(line, cursorCol);
	const active = findActiveFileReference(line, cursor);

	if (!active) {
		return finalizeInsertedReference(
			`${line.slice(0, cursor)}${reference}${line.slice(cursor)}`,
			cursor + reference.length,
		);
	}

	return finalizeInsertedReference(
		`${line.slice(0, active.tokenStart)}${reference}${line.slice(active.tokenEnd)}`,
		active.tokenStart + reference.length,
	);
}
