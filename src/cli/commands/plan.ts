import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../../config";
import { runPlanWithInputs } from "../../orchestrator/phases/plan";
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

export function registerPlanCommand(program: Command): void {
	program
		.command("plan")
		.argument("<prompt...>", "Task description to plan from")
		.option("--rfc <path>", "Path to the polished RFC to use as context")
		.description("Run the interactive plan phase without the TUI")
		.action(async (promptParts: string[], options: { rfc?: string }) => {
			const prompt = promptParts.join(" ").trim();
			const config = loadConfig();
			const runtime = createAgentRuntime({
				provider: config.provider,
				providers: config.providers,
			});
			const prompts = createPromptBuilder();
			const projectCwd = process.cwd();
			const implementationsDir = join(projectCwd, config.implementationsDir);
			const now = new Date().toISOString();
			const runId = randomUUID();
			const runSlug = slugify(prompt || "plan");

			const ctx: PhaseContext = {
				runId,
				run: {
					id: runId,
					taskDescription: prompt,
					slug: runSlug,
					status: "running",
					currentPhase: "plan",
					baseBranch: "main",
					workingBranch: null,
					createdAt: now,
					updatedAt: now,
				},
				phase: "plan",
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

			const rfcPath = options.rfc ? resolve(projectCwd, options.rfc) : undefined;
			const result = await runPlanWithInputs(ctx, { rfcPath });

			if (result.status !== "completed" || !result.output) {
				console.error(result.error ?? "Plan phase failed.");
				process.exitCode = 1;
				return;
			}

			console.info(`Plan saved to ${result.output}`);
		});
}
