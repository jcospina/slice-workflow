import type { Command } from "commander";

export function registerResumeCommand(program: Command): void {
	program
		.command("resume")
		.description("Resume work from PR feedback")
		.requiredOption("--pr <number>", "PR number to resume from")
		.action((opts: { pr: string }) => {
			console.info(`resume: PR #${opts.pr} (not yet implemented)`);
		});
}
