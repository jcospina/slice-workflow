import { randomUUID } from "node:crypto";
import type {
	AgentInteractiveOptions,
	AgentRunOptions,
	AgentRunResult,
	AgentRuntime,
} from "../types";
import {
	type ClaudeCliInvocation,
	type ClaudeCliProcessResult,
	type ClaudeCodeRuntimeConfig,
	buildAutonomousPrompt,
	buildClaudeArgs,
	buildInteractiveClaudeArgs,
	buildInteractivePrompt,
	normalizeRunResult,
	runClaudeCli,
} from "./utils";

export type { ClaudeCodeRuntimeConfig } from "./utils";

interface ClaudeCodeRuntimeDependencies {
	runClaudeCli?: (invocation: ClaudeCliInvocation) => Promise<ClaudeCliProcessResult>;
	now?: () => number;
	createSessionId?: () => string;
}

export class ClaudeCodeRuntime implements AgentRuntime {
	readonly provider = "claude-code";
	readonly config: ClaudeCodeRuntimeConfig;
	private readonly runClaudeCli: (
		invocation: ClaudeCliInvocation,
	) => Promise<ClaudeCliProcessResult>;
	private readonly now: () => number;
	private readonly createSessionId: () => string;

	constructor(
		config: ClaudeCodeRuntimeConfig = {},
		dependencies: ClaudeCodeRuntimeDependencies = {},
	) {
		this.config = config;
		this.runClaudeCli =
			dependencies.runClaudeCli ?? ((invocation) => runClaudeCli(invocation, this.provider));
		this.now = dependencies.now ?? Date.now;
		this.createSessionId = dependencies.createSessionId ?? randomUUID;
	}

	async run(options: AgentRunOptions): Promise<AgentRunResult> {
		const prompt = await buildAutonomousPrompt(options, this.provider);
		const startedAt = this.now();

		options.onProgress?.({ type: "agent_start" });

		let execution: ClaudeCliProcessResult;

		try {
			execution = await this.runClaudeCli({
				command: this.config.command ?? "claude",
				args: buildClaudeArgs(prompt, this.config, options),
				cwd: options.cwd,
				method: "run",
				onStdout: (chunk) => {
					if (chunk.length > 0) {
						options.onProgress?.({ type: "text_output", text: chunk });
					}
				},
			});
		} catch (error) {
			options.onProgress?.({
				type: "error",
				message: error instanceof Error ? error.message : "Failed to launch Claude CLI.",
			});
			throw error;
		}

		const durationMs = Math.max(0, this.now() - startedAt);
		const result = normalizeRunResult(execution, durationMs, this.createSessionId());

		if (!result.success && result.error) {
			options.onProgress?.({ type: "error", message: result.error });
		}

		return result;
	}

	async runInteractive(options: AgentInteractiveOptions): Promise<AgentRunResult> {
		const startedAt = this.now();
		const sessionId = this.createSessionId();
		const prompt = await buildInteractivePrompt(options, this.provider);
		const rfcInstruction = options.rfcArtifactPath
			? `When you are done, write the complete RFC draft as a Markdown document to:\n${options.rfcArtifactPath}`
			: undefined;
		const effectiveSystemPrompt =
			[options.systemPrompt?.trim(), rfcInstruction].filter(Boolean).join("\n\n") || undefined;
		const execution = await this.runClaudeCli({
			command: this.config.command ?? "claude",
			args: buildInteractiveClaudeArgs({
				config: this.config,
				prompt,
				sessionId,
				systemPrompt: effectiveSystemPrompt,
			}),
			cwd: options.cwd,
			method: "runInteractive",
			stdio: "inherit",
		});
		const durationMs = Math.max(0, this.now() - startedAt);
		return normalizeRunResult(execution, durationMs, sessionId);
	}
}
