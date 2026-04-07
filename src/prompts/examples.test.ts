import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getBundledExamplesPath } from "./examples";

describe("getBundledExamplesPath", () => {
	it("returns an absolute path containing required examples", () => {
		const examplesPath = getBundledExamplesPath();

		expect(isAbsolute(examplesPath)).toBe(true);
		expect(existsSync(join(examplesPath, "decouple-data-layer"))).toBe(true);
		expect(existsSync(join(examplesPath, "income-tracking"))).toBe(true);
	});
});
