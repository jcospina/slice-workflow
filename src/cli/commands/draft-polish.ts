import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../../config";
import { runDraftPolishWithArtifacts } from "../../orchestrator/phases/draft-polish";
import type { PhaseContext } from "../../orchestrator/phases/types";
import { createPromptBuilder } from "../../prompts";
import { createAgentRuntime } from "../../runtime";

function slugify(task: string): string {
	return task
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
}

function inferSlugFromInput(inputPath: string): string {
	const fileName = basename(inputPath, extname(inputPath));
	return slugify(fileName || "draft-polish");
}

export function registerDraftPolishCommand(program: Command): void {
	program
		.command("draft-polish")
		.description("Run the autonomous draft-polish phase for an RFC draft file")
		.requiredOption("--input <path>", "Path to the RFC draft markdown file")
		.option("--output <path>", "Path for the polished RFC output")
		.action(async (options: { input: string; output?: string }) => {
			const config = loadConfig();
			const runtime = createAgentRuntime({
				provider: config.provider,
				providers: config.providers,
			});
			const prompts = createPromptBuilder();
			const projectCwd = process.cwd();
			const implementationsDir = join(projectCwd, config.implementationsDir);
			const inputPath = resolve(projectCwd, options.input);
			const outputPath = options.output
				? resolve(projectCwd, options.output)
				: join(dirname(inputPath), "rfc.md");
			const now = new Date().toISOString();
			const runId = randomUUID();
			const runSlug = inferSlugFromInput(inputPath);

			const ctx: PhaseContext = {
				runId,
				run: {
					id: runId,
					taskDescription: `Polish RFC draft at ${inputPath}`,
					slug: runSlug,
					status: "running",
					currentPhase: "draft-polish",
					baseBranch: "main",
					workingBranch: null,
					createdAt: now,
					updatedAt: now,
				},
				phase: "draft-polish",
				config,
				runtime,
				state: {} as PhaseContext["state"],
				worktree: {} as PhaseContext["worktree"],
				messaging: {} as PhaseContext["messaging"],
				prompts,
				projectCwd,
				implementationsDir,
				resumeContext: undefined,
				onEvent: undefined,
			};

			const result = await runDraftPolishWithArtifacts(ctx, { inputPath, outputPath });

			if (result.status !== "completed" || !result.output) {
				console.error(result.error ?? "Draft polish phase failed.");
				process.exitCode = 1;
				return;
			}

			console.info(`Polished RFC saved to ${result.output}`);
		});
}
