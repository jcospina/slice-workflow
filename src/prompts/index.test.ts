import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PhaseContext } from "../orchestrator/phases/types";
import { getBundledExamplesPath } from "./examples";
import { createPromptBuilder, mapPhaseToTemplatePhase } from "./index";
import type { PromptBuildInput, PromptTemplatePhase } from "./types";

const ALL_TEMPLATE_PHASES: PromptTemplatePhase[] = [
	"rfc-draft",
	"draft-polish",
	"plan",
	"slice-execution",
	"slice-review",
	"slice-fix",
	"handoff",
];

describe("DefaultPromptBuilder", () => {
	let root: string;
	let inputBase: Omit<PromptBuildInput, "topLevelPhase">;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "slice-prompts-builder-"));
		await mkdir(join(root, "tracks"), { recursive: true });
		await writeFile(join(root, "demo.md"), "# Plan\nExample plan content.");
		await writeFile(join(root, "PROGRESS.md"), "# Progress\nDecision history.");
		await writeFile(join(root, "tracks", "02-impl.md"), "# Track\nCurrent slice details.");

		inputBase = {
			slug: "demo",
			runId: "run-1",
			taskDescription: "Implement demo workflow",
			files: {
				planPath: join(root, "demo.md"),
				progressPath: join(root, "PROGRESS.md"),
				currentTrackPath: join(root, "tracks", "02-impl.md"),
			},
			slice: {
				index: 2,
				name: "Data Layer",
				dod: "- Add repository abstraction\n- Update usage sites",
			},
			review: {
				iteration: 1,
				severityThreshold: "major",
				findings: [
					{
						severity: "major",
						file: "src/service.ts",
						title: "Missing null guard",
						body: "Null input can crash execution path.",
						dodItem: "Service handles optional values",
						lineRange: [12, 18],
					},
				],
			},
		};
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("uses buildPrompt as canonical source and keeps wrapper compatibility", async () => {
		const builder = createPromptBuilder();
		const phaseContext = makePhaseContext("plan", "demo");

		const direct = await builder.buildPrompt("plan", {
			slug: phaseContext.run.slug,
			runId: phaseContext.runId,
			taskDescription: phaseContext.run.taskDescription,
			topLevelPhase: phaseContext.phase,
			includeContext: false,
		});

		await expect(builder.buildSystemPrompt("plan", phaseContext)).resolves.toBe(
			direct.layers.system,
		);
		await expect(builder.buildTaskPrompt("plan", phaseContext)).resolves.toBe(direct.layers.task);
	});

	it("maps top-level execute phase to slice-execution template", () => {
		expect(mapPhaseToTemplatePhase("execute")).toBe("slice-execution");
	});

	it("includes bundled examples path in the plan template", async () => {
		const builder = createPromptBuilder();
		const result = await builder.buildPrompt("plan", inputBase);

		expect(result.layers.system).toContain(getBundledExamplesPath());
	});

	it("enforces required guardrails in template content", async () => {
		const builder = createPromptBuilder();

		const execution = await builder.buildPrompt("slice-execution", inputBase);
		expect(execution.layers.system).toContain("Do NOT read other files in the tracks/ directory.");

		const review = await builder.buildPrompt("slice-review", inputBase);
		expect(review.layers.system).toContain('"verdict": "PASS" | "FAIL"');
		expect(review.layers.system).toContain("critical, major, minor");
		expect(review.layers.task).toContain("Only include findings introduced by this diff.");
	});

	for (const phase of ALL_TEMPLATE_PHASES) {
		it(`builds stable composed prompt snapshot for ${phase}`, async () => {
			const builder = createPromptBuilder();
			const result = await builder.buildPrompt(phase, {
				...inputBase,
				topLevelPhase: phase === "slice-execution" ? "execute" : undefined,
			});

			const normalized = result.composedPrompt.replaceAll(
				getBundledExamplesPath(),
				"<BUNDLED_EXAMPLES_PATH>",
			);
			expect(normalized).toMatchSnapshot();
		});
	}
});

function makePhaseContext(
	phase: "rfc-draft" | "draft-polish" | "plan" | "execute" | "handoff",
	slug: string,
): PhaseContext {
	return {
		runId: "run-1",
		run: {
			id: "run-1",
			taskDescription: "Task",
			slug,
			status: "running",
			currentPhase: phase,
			baseBranch: "main",
			workingBranch: "feature/demo",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
		phase,
		config: {} as PhaseContext["config"],
		runtime: {} as PhaseContext["runtime"],
		state: {} as PhaseContext["state"],
		worktree: {} as PhaseContext["worktree"],
		messaging: {} as PhaseContext["messaging"],
		prompts: {} as PhaseContext["prompts"],
		projectCwd: "/repo",
		implementationsDir: "/repo/implementations",
		resumeContext: undefined,
		onEvent: undefined,
	};
}
