import type { Command } from "commander";

export function registerSetupGithubCommand(program: Command): void {
	program
		.command("setup-github")
		.description("Install the Slice GitHub Action in your repository")
		.action(() => {
			console.info("setup-github: (not yet implemented)");
		});
}
