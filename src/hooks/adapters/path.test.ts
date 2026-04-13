import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBundledHookAdapterCommand, getBundledHookAdapterScriptPath } from "./path";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: vi.fn() };
});

describe("hook adapter path resolution", () => {
	beforeEach(() => {
		vi.mocked(existsSync).mockReturnValue(false);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("returns absolute dist path for Slack adapter", () => {
		vi.mocked(existsSync).mockImplementation(
			(p) => typeof p === "string" && p.endsWith("dist/hooks/adapters/notify-slack.js"),
		);
		const path = getBundledHookAdapterScriptPath("slack");
		expect(isAbsolute(path)).toBe(true);
		expect(path.endsWith("dist/hooks/adapters/notify-slack.js")).toBe(true);
	});

	it("returns absolute dist path for Telegram adapter", () => {
		vi.mocked(existsSync).mockImplementation(
			(p) => typeof p === "string" && p.endsWith("dist/hooks/adapters/notify-telegram.js"),
		);
		const path = getBundledHookAdapterScriptPath("telegram");
		expect(isAbsolute(path)).toBe(true);
		expect(path.endsWith("dist/hooks/adapters/notify-telegram.js")).toBe(true);
	});

	it("throws when adapter script cannot be found", () => {
		expect(() => getBundledHookAdapterScriptPath("slack")).toThrow(
			"Unable to locate bundled hook adapter script 'notify-slack.js'",
		);
	});

	it("builds a node command with quoted executable and script path", () => {
		vi.mocked(existsSync).mockImplementation(
			(p) => typeof p === "string" && p.endsWith("dist/hooks/adapters/notify-slack.js"),
		);
		const command = createBundledHookAdapterCommand("slack");
		expect(command).toContain(JSON.stringify(process.execPath));
		expect(command).toContain("/notify-slack.js");
	});
});
