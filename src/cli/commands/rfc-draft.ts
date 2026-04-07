import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../../config";
import { runRfcDraftPhase } from "../../orchestrator/phases/rfc-draft";
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

export function registerRfcDraftCommand(program: Command): void {
	program
		.command("rfc-draft")
		.argument("<prompt...>", "Prompt to draft the RFC from")
		.description("Run the interactive RFC draft phase without the TUI")
		.action(async (promptParts: string[]) => {
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
			const runSlug = slugify(prompt || "rfc-draft");

			const ctx: PhaseContext = {
				runId,
				run: {
					id: runId,
					taskDescription: prompt,
					slug: runSlug,
					status: "running",
					currentPhase: "rfc-draft",
					baseBranch: "main",
					workingBranch: null,
					createdAt: now,
					updatedAt: now,
				},
				phase: "rfc-draft",
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

			const result = await runRfcDraftPhase(ctx);

			if (result.status !== "completed" || !result.output) {
				console.error(result.error ?? "RFC draft phase failed.");
				process.exitCode = 1;
				return;
			}

			console.info(`RFC draft saved to ${result.output}`);
		});
}
