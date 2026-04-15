import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ContextBudgetExceededError,
	buildContextBlock,
	buildContextBlockFromContent,
} from "./context";

describe("buildContextBlock", () => {
	let root: string;
	let planPath: string;
	let progressPath: string;
	let currentTrackPath: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "slice-prompts-context-"));
		await mkdir(join(root, "tracks"), { recursive: true });

		planPath = join(root, "demo.md");
		progressPath = join(root, "PROGRESS.md");
		currentTrackPath = join(root, "tracks", "02-data-layer.md");

		await writeFile(planPath, "# Plan\nPlan details.");
		await writeFile(progressPath, "# Progress\nKey decisions.");
		await writeFile(currentTrackPath, "# Track 02\nScope and DoD.");
		await writeFile(join(root, "tracks", "01-old.md"), "SHOULD_NOT_BE_INCLUDED");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("loads exactly the provided 3 files and does not include other track files", async () => {
		const result = await buildContextBlock({
			files: { planPath, progressPath, currentTrackPath },
		});

		expect(result.text).toContain("# Plan\nPlan details.");
		expect(result.text).toContain("# Progress\nKey decisions.");
		expect(result.text).toContain("# Track 02\nScope and DoD.");
		expect(result.text).not.toContain("SHOULD_NOT_BE_INCLUDED");
	});

	it("keeps deterministic section order", async () => {
		const result = await buildContextBlock({
			files: { planPath, progressPath, currentTrackPath },
		});

		const planStart = result.text.indexOf("=== PLAN DOCUMENT ===");
		const progressStart = result.text.indexOf("=== PROGRESS DOCUMENT ===");
		const trackStart = result.text.indexOf("=== CURRENT TRACK FILE ===");

		expect(planStart).toBeGreaterThan(-1);
		expect(progressStart).toBeGreaterThan(planStart);
		expect(trackStart).toBeGreaterThan(progressStart);
	});

	it("throws when one of the required files is missing", async () => {
		await expect(
			buildContextBlock({
				files: {
					planPath,
					progressPath,
					currentTrackPath: join(root, "tracks", "missing.md"),
				},
			}),
		).rejects.toThrow("Failed to read current track file");
	});

	it("throws ContextBudgetExceededError when budget is exceeded", async () => {
		await expect(
			buildContextBlock({
				files: { planPath, progressPath, currentTrackPath },
				maxChars: 80,
			}),
		).rejects.toBeInstanceOf(ContextBudgetExceededError);
	});
});

describe("buildContextBlockFromContent", () => {
	it("assembles content from pre-read strings without file I/O", () => {
		const result = buildContextBlockFromContent({
			planDoc: "# Plan\nPlan details.",
			progressDoc: "# Progress\nKey decisions.",
			trackDoc: "# Track 02\nScope and DoD.",
		});

		expect(result.text).toContain("# Plan\nPlan details.");
		expect(result.text).toContain("# Progress\nKey decisions.");
		expect(result.text).toContain("# Track 02\nScope and DoD.");
	});

	it("keeps deterministic section order", () => {
		const result = buildContextBlockFromContent({
			planDoc: "plan",
			progressDoc: "progress",
			trackDoc: "track",
		});

		const planStart = result.text.indexOf("=== PLAN DOCUMENT ===");
		const progressStart = result.text.indexOf("=== PROGRESS DOCUMENT ===");
		const trackStart = result.text.indexOf("=== CURRENT TRACK FILE ===");

		expect(planStart).toBeGreaterThan(-1);
		expect(progressStart).toBeGreaterThan(planStart);
		expect(trackStart).toBeGreaterThan(progressStart);
	});

	it("returns charCount equal to text length", () => {
		const result = buildContextBlockFromContent({
			planDoc: "plan",
			progressDoc: "progress",
			trackDoc: "track",
		});

		expect(result.charCount).toBe(result.text.length);
	});

	it("returns the default maxChars when none is supplied", () => {
		const result = buildContextBlockFromContent({
			planDoc: "plan",
			progressDoc: "progress",
			trackDoc: "track",
		});

		expect(result.maxChars).toBeGreaterThan(0);
	});

	it("returns the provided maxChars", () => {
		const result = buildContextBlockFromContent(
			{ planDoc: "plan", progressDoc: "progress", trackDoc: "track" },
			999_999,
		);

		expect(result.maxChars).toBe(999_999);
	});

	it("throws ContextBudgetExceededError when content exceeds maxChars", () => {
		expect(() =>
			buildContextBlockFromContent(
				{ planDoc: "plan", progressDoc: "progress", trackDoc: "track" },
				80,
			),
		).toThrow(ContextBudgetExceededError);
	});

	it("includes context rules header in output", () => {
		const result = buildContextBlockFromContent({
			planDoc: "plan",
			progressDoc: "progress",
			trackDoc: "track",
		});

		expect(result.text).toContain("Context Rules:");
	});
});
