import type { Provider, ResolvedConfig } from "../config/types";
import { RuntimeError } from "../utils/errors";
import { ClaudeCodeRuntime } from "./claude-code";
import type { AgentRuntime } from "./types";

type ProviderConfigs = ResolvedConfig["providers"];

export interface RuntimeFactoryConfig {
	provider: Provider;
	providers?: Partial<ProviderConfigs>;
}

export function createAgentRuntime(config: RuntimeFactoryConfig): AgentRuntime {
	switch (config.provider) {
		case "claude-code":
			return new ClaudeCodeRuntime(config.providers?.claudeCode ?? {});
		case "opencode":
			throw new RuntimeError("Provider 'opencode' does not have a runtime implementation yet.", {
				provider: config.provider,
			});
		default:
			throw new RuntimeError(`Provider '${config.provider}' is not supported.`, {
				provider: config.provider,
			});
	}
}
