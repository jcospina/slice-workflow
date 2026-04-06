import { randomUUID } from "node:crypto";
import type {
	AgentInteractiveOptions,
	AgentRunOptions,
	AgentRunResult,
	AgentRuntime,
} from "../types";
import { LocalOpenCodeServeManager, type OpenCodeServeManager } from "./serve-manager";
import type { OpenCodeRuntimeConfig, OpenCodeRuntimeDependencies } from "./types";
import {
	buildAutonomousPrompt,
	buildInteractiveOpenCodeArgs,
	buildInteractivePrompt,
	buildSessionTitle,
	buildToolsMap,
	createDefaultOpenCodeClient,
	extractErrorMessage,
	normalizeInteractiveRunResult,
	normalizePromptResult,
	parseConfiguredModel,
	runOpenCodeCli,
	startPermissionAutoResponder,
	unwrapApiResult,
} from "./utils";

export type { OpenCodeRuntimeConfig, OpenCodeRuntimeDependencies } from "./types";
export type { OpenCodeServeManager } from "./serve-manager";

export class OpenCodeRuntime implements AgentRuntime {
	readonly provider = "opencode";
	readonly config: OpenCodeRuntimeConfig;
	readonly serveManager: OpenCodeServeManager;
	private readonly createClient: NonNullable<OpenCodeRuntimeDependencies["createClient"]>;
	private readonly runOpenCodeCli: NonNullable<OpenCodeRuntimeDependencies["runOpenCodeCli"]>;
	private readonly now: NonNullable<OpenCodeRuntimeDependencies["now"]>;
	private readonly createSessionId: NonNullable<OpenCodeRuntimeDependencies["createSessionId"]>;

	constructor(config: OpenCodeRuntimeConfig = {}, dependencies: OpenCodeRuntimeDependencies = {}) {
		this.config = config;
		this.serveManager =
			dependencies.serveManager ??
			new LocalOpenCodeServeManager({ command: config.command ?? "opencode" });
		this.createClient = dependencies.createClient ?? createDefaultOpenCodeClient;
		this.runOpenCodeCli =
			dependencies.runOpenCodeCli ?? ((invocation) => runOpenCodeCli(invocation, this.provider));
		this.now = dependencies.now ?? Date.now;
		this.createSessionId = dependencies.createSessionId ?? randomUUID;
	}

	async run(options: AgentRunOptions): Promise<AgentRunResult> {
		const startedAt = this.now();
		let sessionId = this.createSessionId();

		options.onProgress?.({ type: "agent_start" });

		try {
			await this.serveManager.ensureServer({ cwd: options.cwd });

			const client = this.createClient(options.cwd);
			const createdSession = unwrapApiResult(
				await client.session.create({
					query: { directory: options.cwd },
					body: { title: buildSessionTitle(options.prompt) },
				}),
				"Failed to create OpenCode session.",
				this.provider,
				"run",
			);

			sessionId = createdSession.id || sessionId;

			const permissionAutoResponder = startPermissionAutoResponder({
				client,
				cwd: options.cwd,
				sessionId,
			});

			try {
				const prompt = await buildAutonomousPrompt(options, this.provider);
				const promptResult = unwrapApiResult(
					await client.session.prompt({
						path: { id: sessionId },
						query: { directory: options.cwd },
						body: {
							parts: [{ type: "text", text: prompt }],
							system: options.systemPrompt?.trim() || undefined,
							model: parseConfiguredModel(this.config.model),
							tools: buildToolsMap(options.allowedTools),
						},
					}),
					"Failed to execute OpenCode session prompt.",
					this.provider,
					"run",
				);
				const durationMs = Math.max(0, this.now() - startedAt);
				const normalizedResult = normalizePromptResult(promptResult, durationMs, sessionId);

				if (!normalizedResult.success && normalizedResult.error) {
					options.onProgress?.({ type: "error", message: normalizedResult.error });
				}

				return normalizedResult;
			} finally {
				await permissionAutoResponder.stop();
			}
		} catch (error) {
			const durationMs = Math.max(0, this.now() - startedAt);
			const message = extractErrorMessage(error);

			options.onProgress?.({ type: "error", message });

			return {
				success: false,
				output: message,
				sessionId,
				costUsd: 0,
				durationMs,
				error: message,
			};
		}
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
		const execution = await this.runOpenCodeCli({
			command: this.config.command ?? "opencode",
			args: buildInteractiveOpenCodeArgs({
				model: this.config.model,
				prompt,
				systemPrompt: effectiveSystemPrompt,
			}),
			cwd: options.cwd,
			method: "runInteractive",
			stdio: "inherit",
		});
		const durationMs = Math.max(0, this.now() - startedAt);

		return normalizeInteractiveRunResult(execution, durationMs, sessionId);
	}
}
