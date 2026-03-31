import {
	type Dirent,
	type PathLike,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FILE_REFERENCE_EXCLUDED_DIRS,
	filterFileReferences,
	findActiveFileReference,
	formatFileReference,
	insertFileReference,
	isFileReferenceSuppressed,
	listWorkspaceFiles,
	resolveFileReferenceViewState,
} from "./file-references";

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");

	return {
		...actual,
		readdirSync: vi.fn((dir: PathLike, options?: Parameters<typeof actual.readdirSync>[1]) => {
			const current = String(dir);
			if (current === "/workspace") {
				return [
					makeDirent("src", "dir"),
					makeDirent("README.md", "file"),
					makeDirent("docs", "dir"),
				];
			}
			if (current === "/workspace/src") {
				return [
					makeDirent("z-last.ts", "file"),
					makeDirent("nested", "dir"),
					makeDirent("a-first.ts", "file"),
				];
			}
			if (current === "/workspace/src/nested") {
				return [makeDirent("deep.ts", "file")];
			}
			if (current === "/workspace/docs") {
				return [makeDirent("guide.md", "file")];
			}
			return actual.readdirSync(dir, options as Parameters<typeof actual.readdirSync>[1]);
		}),
	};
});

function makeDirent(name: string, kind: "file" | "dir"): Dirent {
	return {
		name,
		isFile: () => kind === "file",
		isDirectory: () => kind === "dir",
		isSymbolicLink: () => false,
	} as unknown as Dirent;
}

describe("FILE_REFERENCE_EXCLUDED_DIRS", () => {
	it("covers the expected excluded directories", () => {
		expect(FILE_REFERENCE_EXCLUDED_DIRS).toEqual([".git", "node_modules", "dist", "build"]);
	});
});

describe("listWorkspaceFiles", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "slice-file-ref-test-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("recursively lists repo files and skips excluded directories", () => {
		mkdirSync(join(tmpDir, "src", "nested"), { recursive: true });
		mkdirSync(join(tmpDir, "docs"), { recursive: true });
		mkdirSync(join(tmpDir, ".git"), { recursive: true });
		mkdirSync(join(tmpDir, "node_modules", "pkg"), { recursive: true });
		mkdirSync(join(tmpDir, "dist"), { recursive: true });
		mkdirSync(join(tmpDir, "build"), { recursive: true });

		writeFileSync(join(tmpDir, "README.md"), "# readme");
		writeFileSync(join(tmpDir, "src", "index.ts"), "export {}");
		writeFileSync(join(tmpDir, "src", "nested", "deep.ts"), "export {}");
		writeFileSync(join(tmpDir, "docs", "guide.md"), "# guide");
		writeFileSync(join(tmpDir, ".git", "ignored.txt"), "ignored");
		writeFileSync(join(tmpDir, "node_modules", "pkg", "ignored.js"), "ignored");
		writeFileSync(join(tmpDir, "dist", "bundle.js"), "ignored");
		writeFileSync(join(tmpDir, "build", "artifact.txt"), "ignored");

		const result = listWorkspaceFiles(tmpDir);

		expect(result).toEqual(
			expect.arrayContaining(["README.md", "docs/guide.md", "src/index.ts", "src/nested/deep.ts"]),
		);
		expect(result).not.toContain(".git/ignored.txt");
		expect(result).not.toContain("node_modules/pkg/ignored.js");
		expect(result).not.toContain("dist/bundle.js");
		expect(result).not.toContain("build/artifact.txt");
	});

	it("preserves crawl order instead of sorting", () => {
		const result = listWorkspaceFiles("/workspace");

		expect(result).toEqual([
			"src/z-last.ts",
			"src/nested/deep.ts",
			"src/a-first.ts",
			"README.md",
			"docs/guide.md",
		]);
		expect(readdirSync).toHaveBeenCalled();
	});
});

describe("findActiveFileReference", () => {
	it("detects a bare @ token at the cursor", () => {
		expect(findActiveFileReference("@", 1)).toEqual({
			query: "",
			tokenStart: 0,
			tokenEnd: 1,
		});
	});

	it("captures the active query while typing a path", () => {
		expect(findActiveFileReference("Use @src/cli", 12)).toEqual({
			query: "src/cli",
			tokenStart: 4,
			tokenEnd: 12,
		});
	});

	it("ignores email-style @ characters", () => {
		expect(findActiveFileReference("contact a@b.com", 15)).toBeNull();
	});

	it("ignores tokens that are no longer active after whitespace", () => {
		expect(findActiveFileReference("Use @src/cli now", 16)).toBeNull();
	});
});

describe("filterFileReferences", () => {
	const files = [
		"src/index.ts",
		"src/cli/prompt.ts",
		"docs/guide.md",
		"packages/app/src/index.ts",
		"README.md",
		"tests/index.test.ts",
	];

	it("returns the first five files when the query is empty", () => {
		expect(filterFileReferences(files, "")).toEqual([
			"src/index.ts",
			"src/cli/prompt.ts",
			"docs/guide.md",
			"packages/app/src/index.ts",
			"README.md",
		]);
	});

	it("matches paths case-insensitively by substring", () => {
		expect(filterFileReferences(files, "SRC")).toEqual([
			"src/index.ts",
			"src/cli/prompt.ts",
			"packages/app/src/index.ts",
		]);
	});

	it("respects a custom limit", () => {
		expect(filterFileReferences(files, "index", 2)).toEqual([
			"src/index.ts",
			"packages/app/src/index.ts",
		]);
	});
});

describe("formatFileReference", () => {
	it("formats a plain relative path", () => {
		expect(formatFileReference("src/cli/index.ts")).toBe("@src/cli/index.ts");
	});

	it("quotes paths that contain spaces", () => {
		expect(formatFileReference("docs/Slice based workflow.md")).toBe(
			'@"docs/Slice based workflow.md"',
		);
	});
});

describe("insertFileReference", () => {
	it("replaces the active token with the formatted reference", () => {
		const line = "Open @src/cli/index.ts please";
		const result = insertFileReference(line, line.indexOf(" please"), "packages/app/index.ts");

		expect(result).toEqual({
			line: "Open @packages/app/index.ts please",
			cursorCol: "Open @packages/app/index.ts ".length,
		});
	});

	it("quotes paths that contain spaces", () => {
		const line = "See @docs/guide.md now";
		const result = insertFileReference(line, line.indexOf(" now"), "docs/Slice based workflow.md");

		expect(result).toEqual({
			line: 'See @"docs/Slice based workflow.md" now',
			cursorCol: 'See @"docs/Slice based workflow.md" '.length,
		});
	});

	it("inserts at the cursor when no active reference is present", () => {
		const result = insertFileReference("Write a prompt", 5, "src/index.ts");

		expect(result).toEqual({
			line: "Write@src/index.ts a prompt",
			cursorCol: 5 + "@src/index.ts ".length,
		});
	});

	it("adds a trailing space when inserting at the end of the line", () => {
		const result = insertFileReference("Use @src", 8, "src/index.ts");

		expect(result).toEqual({
			line: "Use @src/index.ts ",
			cursorCol: "Use @src/index.ts ".length,
		});
	});
});

describe("resolveFileReferenceViewState", () => {
	it("returns null when there is no active file reference", () => {
		expect(resolveFileReferenceViewState(["src/index.ts"], "Write a prompt", 5, 0)).toBeNull();
	});

	it("caps matches at five and clamps the highlighted index", () => {
		expect(
			resolveFileReferenceViewState(
				["z.ts", "a.ts", "m.ts", "b.ts", "c.ts", "d.ts"],
				"Use @",
				5,
				10,
			),
		).toEqual({
			query: "",
			matches: ["z.ts", "a.ts", "m.ts", "b.ts", "c.ts"],
			highlightedIndex: 4,
		});
	});
});

describe("isFileReferenceSuppressed", () => {
	it("suppresses the picker while the same selected token remains active", () => {
		expect(
			isFileReferenceSuppressed({ query: "src/index.ts", tokenStart: 4, tokenEnd: 17 }, 0, {
				row: 0,
				tokenStart: 4,
				query: "src/index.ts",
			}),
		).toBe(true);
		expect(
			isFileReferenceSuppressed(
				{ query: '"docs/Slice based workflow.md"', tokenStart: 4, tokenEnd: 35 },
				0,
				{ row: 0, tokenStart: 4, query: '"docs/Slice based workflow.md"' },
			),
		).toBe(true);
		expect(
			isFileReferenceSuppressed({ query: "src/cli", tokenStart: 4, tokenEnd: 12 }, 0, {
				row: 0,
				tokenStart: 4,
				query: "src/index.ts",
			}),
		).toBe(false);
	});
});
