import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDir } from "./fs";

describe("ensureDir", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "slice-fs-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("creates a directory that does not exist", () => {
		const dir = join(tmp, "new-dir");
		ensureDir(dir);
		expect(existsSync(dir)).toBe(true);
	});

	it("creates nested directories", () => {
		const dir = join(tmp, "a", "b", "c");
		ensureDir(dir);
		expect(existsSync(dir)).toBe(true);
	});

	it("does not throw if directory already exists", () => {
		const dir = join(tmp, "existing");
		ensureDir(dir);
		expect(() => ensureDir(dir)).not.toThrow();
	});
});
