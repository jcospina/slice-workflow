import { Command } from "commander";
import { VERSION } from "../index";
import { registerDraftPolishCommand } from "./commands/draft-polish";
import { registerPlanCommand } from "./commands/plan";
import { registerResumeCommand } from "./commands/resume";
import { registerRfcDraftCommand } from "./commands/rfc-draft";
import { registerSetupGithubCommand } from "./commands/setup-github";
import { startTui } from "./tui/index";

export function createProgram(): Command {
	const program = new Command();

	program.name("slice").description("Slice CLI").version(VERSION, "-v, --version");

	program
		.allowExcessArguments(true)
		.allowUnknownOption(true)
		.action((...args: unknown[]) => {
			const cmd = args[args.length - 1] as Command;
			const unknownCommand = cmd.args.find((a) => !a.startsWith("-"));
			if (unknownCommand) {
				program.error(`unknown command '${unknownCommand}'`);
			}
			const unknownOption = cmd.args.find((a) => a.startsWith("-"));
			if (unknownOption) {
				program.error(`unknown option '${unknownOption}'`);
			}
			startTui();
		});

	registerResumeCommand(program);
	registerRfcDraftCommand(program);
	registerDraftPolishCommand(program);
	registerPlanCommand(program);
	registerSetupGithubCommand(program);

	program.showHelpAfterError(true);

	return program;
}
