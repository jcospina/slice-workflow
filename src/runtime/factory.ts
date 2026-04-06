import { execFileSync } from "node:child_process";
import type { Provider, ResolvedConfig } from "../config/types";
import { RuntimeError } from "../utils/errors";
import { ClaudeCodeRuntime } from "./claude-code";
import { OpenCodeRuntime } from "./opencode";
import type { AgentRuntime } from "./types";

type ProviderConfigs = ResolvedConfig["providers"];

export interface RuntimeFactoryConfig {
	provider: Provider;
	providers?: Partial<ProviderConfigs>;
}

export interface RuntimeFactoryDependencies {
	isCommandAvailable?: (command: string) => boolean;
}

const DEFAULT_COMMAND: Record<Provider, string> = {
	"claude-code": "claude",
	opencode: "opencode",
};

function isCommandInPath(command: string): boolean {
	try {
		execFileSync(process.platform === "win32" ? "where" : "which", [command], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

function buildMissingCliMessage(
	command: string,
	provider: Provider,
	fallbackProvider: Provider,
): string {
	const fallbackCommand = DEFAULT_COMMAND[fallbackProvider];
	return (
		`The '${command}' CLI required by the '${provider}' provider was not found on PATH. ` +
		`Install it and ensure it is available, or switch to the '${fallbackProvider}' provider ` +
		`(requires '${fallbackCommand}' to be installed).`
	);
}

export function createAgentRuntime(
	config: RuntimeFactoryConfig,
	dependencies: RuntimeFactoryDependencies = {},
): AgentRuntime {
	const checkCommand = dependencies.isCommandAvailable ?? isCommandInPath;

	switch (config.provider) {
		case "claude-code": {
			const command = config.providers?.claudeCode?.command ?? DEFAULT_COMMAND["claude-code"];
			if (!checkCommand(command)) {
				throw new RuntimeError(buildMissingCliMessage(command, "claude-code", "opencode"), {
					provider: "claude-code",
					command,
				});
			}
			return new ClaudeCodeRuntime(config.providers?.claudeCode ?? {});
		}
		case "opencode": {
			const command = config.providers?.opencode?.command ?? DEFAULT_COMMAND.opencode;
			if (!checkCommand(command)) {
				throw new RuntimeError(buildMissingCliMessage(command, "opencode", "claude-code"), {
					provider: "opencode",
					command,
				});
			}
			return new OpenCodeRuntime(config.providers?.opencode ?? {});
		}
		default:
			throw new RuntimeError(`Provider '${config.provider}' is not supported.`, {
				provider: config.provider,
			});
	}
}
