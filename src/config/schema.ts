import { z } from "zod";
import { DEFAULT_HOOK_TIMEOUT_MS, HOOK_EVENTS } from "../hooks/types";

const providerEnum = z
	.enum(["claude-code", "opencode"])
	.describe("Agent runtime to use for executing phases and slices");

const sliceExecutionEnum = z
	.enum(["autonomous", "gated"])
	.describe("Whether slices run start-to-end or pause for approval after each slice");

const severityEnum = z
	.enum(["critical", "major", "minor"])
	.describe("Review finding severity level used to decide whether to trigger fix iterations");

const claudeCodeProviderSchema = z.object({
	model: z.string().optional().describe("Claude model to use (e.g. 'sonnet', 'opus')"),
	command: z
		.string()
		.optional()
		.describe(
			"Claude CLI executable name or path (e.g. 'claude', 'klaude', '/usr/local/bin/claude')",
		),
});

const opencodeProviderSchema = z.object({
	model: z
		.string()
		.optional()
		.describe("Model identifier in provider/model format (e.g. 'ollama/qwen2.5-coder:32b')"),
	command: z
		.string()
		.optional()
		.describe(
			"OpenCode CLI executable name or path (must be installed/runnable, e.g. 'opencode', '/usr/local/bin/opencode')",
		),
});

const providersSchema = z.object({
	claudeCode: claudeCodeProviderSchema
		.optional()
		.describe("Configuration for the Claude Code agent runtime"),
	opencode: opencodeProviderSchema
		.optional()
		.describe("Configuration for the OpenCode agent runtime"),
});

const slackConfigSchema = z.object({
	appToken: z
		.string()
		.optional()
		.describe("Slack App-level token (xapp-...) for Socket Mode WebSocket connection"),
	botToken: z
		.string()
		.optional()
		.describe("Slack Bot token (xoxb-...) for sending messages and handling interactions"),
	defaultChannel: z
		.string()
		.optional()
		.describe("Default Slack channel for notifications when no project-level channel is set"),
	channel: z
		.string()
		.optional()
		.describe("Slack channel override for this project's notifications"),
});

const telegramConfigSchema = z.object({
	botToken: z
		.string()
		.optional()
		.describe("Telegram bot token from @BotFather for sending messages and inline keyboards"),
	chatId: z
		.string()
		.optional()
		.describe("Telegram chat ID for the target conversation (user or group)"),
});

const messagingSchema = z.object({
	slack: slackConfigSchema
		.optional()
		.describe("Slack integration for bidirectional notifications and approval gates"),
	telegram: telegramConfigSchema
		.optional()
		.describe("Telegram integration for bidirectional notifications and approval gates"),
});

const approvalGatesSchema = z.object({
	rfc: z
		.boolean()
		.optional()
		.describe("Whether to require human approval after the RFC draft phase"),
	plan: z
		.boolean()
		.optional()
		.describe("Whether to require human approval after the plan generation phase"),
});

const reviewSchema = z.object({
	enabled: z
		.boolean()
		.optional()
		.describe("Whether to run a reviewer agent after each slice to check changes against DoD"),
	maxIterations: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("Maximum review-fix cycles before escalating to human (default: 2)"),
	reviewProvider: z
		.string()
		.optional()
		.describe("Optional alternative provider for the reviewer agent (e.g. use a cheaper model)"),
	severityThreshold: severityEnum
		.optional()
		.describe(
			"Minimum severity that triggers a fix iteration; 'minor' findings are logged but don't loop",
		),
});

const hookEventEnum = z
	.enum(HOOK_EVENTS)
	.describe("Lifecycle event that can trigger notification hooks");

function isValidRegex(pattern: string): boolean {
	try {
		new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
}

const hookMatcherSchema = z
	.string()
	.trim()
	.min(1)
	.refine(isValidRegex, "Matcher must be a valid regular expression")
	.describe(
		"Regex pattern tested against the serialized hook input JSON payload; if omitted, the hook matches all payloads for its events",
	);

const hookDefinitionSchema = z.object({
	command: z
		.string()
		.trim()
		.min(1)
		.describe("Shell command to execute when a configured lifecycle event is emitted"),
	events: z.array(hookEventEnum).min(1).describe("Lifecycle events that can trigger this hook"),
	matcher: hookMatcherSchema.optional(),
	timeoutMs: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Per-hook command timeout in milliseconds (defaults to 5000ms when omitted)"),
	async: z
		.boolean()
		.optional()
		.describe(
			"When true, the hook runs fire-and-forget and does not block the orchestrator. Defaults to false.",
		),
});

const resolvedHookDefinitionSchema = z.object({
	command: z
		.string()
		.trim()
		.min(1)
		.describe("Shell command to execute when a configured lifecycle event is emitted"),
	events: z.array(hookEventEnum).min(1).describe("Lifecycle events that can trigger this hook"),
	matcher: hookMatcherSchema.optional(),
	timeoutMs: z
		.number()
		.int()
		.positive()
		.default(DEFAULT_HOOK_TIMEOUT_MS)
		.describe("Resolved per-hook timeout in milliseconds (defaults to 5000ms)"),
	async: z
		.boolean()
		.default(false)
		.describe(
			"When true, the hook runs fire-and-forget and does not block the orchestrator (default: false).",
		),
});

export const globalConfigSchema = z
	.object({
		defaultProvider: providerEnum
			.optional()
			.describe("Default agent runtime used when no project-level provider is set"),
		providers: providersSchema.optional().describe("Model configuration for each agent runtime"),
		messaging: messagingSchema
			.optional()
			.describe("Global messaging tokens shared across all projects"),
		hooks: z
			.array(hookDefinitionSchema)
			.optional()
			.describe(
				"Global lifecycle notification hooks. Project hooks append after these in deterministic order.",
			),
	})
	.describe("User-level configuration stored at ~/.slice/config.json");

export const projectConfigSchema = z
	.object({
		provider: providerEnum
			.optional()
			.describe("Agent runtime for this project (overrides global defaultProvider)"),
		providers: providersSchema
			.optional()
			.describe("Project-level model overrides for agent runtimes"),
		implementationsDir: z
			.string()
			.optional()
			.describe(
				"Directory where plan docs, PROGRESS.md, and track files are created (default: 'implementations')",
			),
		approvalGates: approvalGatesSchema
			.optional()
			.describe("Control which phases require human approval before proceeding"),
		sliceExecution: sliceExecutionEnum
			.optional()
			.describe("Slice execution mode: 'autonomous' runs all slices, 'gated' pauses after each"),
		review: reviewSchema
			.optional()
			.describe("Post-slice review loop configuration (evaluator-optimizer pattern)"),
		messaging: messagingSchema
			.optional()
			.describe("Project-level messaging overrides (e.g. channel per project)"),
		hooks: z
			.array(hookDefinitionSchema)
			.optional()
			.describe(
				"Project lifecycle notification hooks appended after global hooks in deterministic order.",
			),
	})
	.describe("Project-level configuration stored at .slicerc in the project root");

// --- Resolved config schema (output of merge, with defaults) ---

const resolvedSlackConfigSchema = z.object({
	appToken: z
		.string()
		.describe("Slack App-level token (xapp-...) — required for Slack to be active"),
	botToken: z.string().describe("Slack Bot token (xoxb-...) — required for Slack to be active"),
	channel: z.string().describe("Resolved Slack channel for this project's notifications"),
});

const resolvedTelegramConfigSchema = z.object({
	botToken: z.string().describe("Telegram bot token — required for Telegram to be active"),
	chatId: z.string().describe("Telegram chat ID — required for Telegram to be active"),
});

export const resolvedConfigSchema = z
	.object({
		provider: providerEnum
			.default("claude-code")
			.describe(
				"Active agent runtime after merging project.provider → global.defaultProvider → default",
			),
		providers: z
			.object({
				claudeCode: claudeCodeProviderSchema
					.default({})
					.describe("Resolved Claude Code runtime configuration"),
				opencode: opencodeProviderSchema
					.default({})
					.describe("Resolved OpenCode runtime configuration"),
			})
			.default({ claudeCode: {}, opencode: {} })
			.describe("Merged model configuration for each agent runtime"),
		messaging: z
			.object({
				slack: resolvedSlackConfigSchema
					.optional()
					.describe("Present only when both appToken and botToken are configured"),
				telegram: resolvedTelegramConfigSchema
					.optional()
					.describe("Present only when both botToken and chatId are configured"),
			})
			.default({})
			.describe(
				"Resolved messaging integrations (only includes platforms with complete credentials)",
			),
		hooks: z
			.array(resolvedHookDefinitionSchema)
			.default([])
			.describe(
				"Resolved lifecycle notification hooks. Merge order is deterministic: global hooks first, then project hooks.",
			),
		implementationsDir: z
			.string()
			.default("implementations")
			.describe("Directory for plan docs, PROGRESS.md, and track files"),
		approvalGates: z
			.object({
				rfc: z.boolean().default(true).describe("Require human approval after RFC draft phase"),
				plan: z
					.boolean()
					.default(true)
					.describe("Require human approval after plan generation phase"),
			})
			.default({ rfc: true, plan: true })
			.describe("Which workflow phases pause for human approval"),
		sliceExecution: sliceExecutionEnum
			.default("autonomous")
			.describe("Whether slices run continuously or pause for approval after each"),
		review: z
			.object({
				enabled: z
					.boolean()
					.default(true)
					.describe("Run a reviewer agent after each slice to check changes against DoD"),
				maxIterations: z
					.number()
					.int()
					.min(1)
					.default(2)
					.describe("Maximum review-fix cycles before escalating to human"),
				severityThreshold: severityEnum
					.default("major")
					.describe("Minimum severity that triggers a fix iteration"),
				reviewProvider: z
					.string()
					.optional()
					.describe("Alternative provider for the reviewer agent (e.g. cheaper model)"),
			})
			.default({ enabled: true, maxIterations: 2, severityThreshold: "major" })
			.describe("Post-slice review loop configuration"),
	})
	.describe("Fully resolved configuration with all defaults applied");

export { providerEnum, sliceExecutionEnum, severityEnum };
