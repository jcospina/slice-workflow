import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { createBundledHookAdapterCommand } from "../../hooks/adapters/path";
import { createHookRunner } from "../../hooks/runner";
import type { HookAdapter, HookInput, ResolvedHookDefinition } from "../../hooks/types";

const NEWLINE_SPLIT_RE = /\r?\n/u;
const ENV_ASSIGNMENT_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u;
const SLACK_BOT_TOKEN_ENV = "SLACK_BOT_TOKEN";
const SLACK_CHANNEL_ENV = "SLACK_CHANNEL";
const TELEGRAM_BOT_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";
const TELEGRAM_CHAT_ID_ENV = "TELEGRAM_CHAT_ID";

interface SmokeCommandOptions {
	envFile: string;
	message?: string;
}

interface SmokeSlackOptions extends SmokeCommandOptions {
	channel: string;
}

interface SmokeTelegramOptions extends SmokeCommandOptions {
	chatId: string;
}

interface ParsedHookExecution {
	success: boolean;
	error: string | null;
	hook?: { command?: string };
	stderr?: string;
	stdout?: string;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	timedOut?: boolean;
}

interface ParsedHookRunResult {
	executions: ParsedHookExecution[];
}

function parseEnvFile(content: string): Record<string, string> {
	const env: Record<string, string> = {};

	for (const rawLine of content.split(NEWLINE_SPLIT_RE)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) {
			continue;
		}

		const match = ENV_ASSIGNMENT_RE.exec(line);
		if (!match) {
			continue;
		}

		const key = match[1];
		const rawValue = match[2] ?? "";
		env[key] = parseEnvValue(rawValue);
	}

	return env;
}

function parseEnvValue(rawValue: string): string {
	const trimmed = rawValue.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
		return trimmed
			.slice(1, -1)
			.replace(/\\n/g, "\n")
			.replace(/\\r/g, "\r")
			.replace(/\\t/g, "\t")
			.replace(/\\"/g, '"');
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
		return trimmed.slice(1, -1);
	}
	const commentIndex = trimmed.indexOf(" #");
	if (commentIndex >= 0) {
		return trimmed.slice(0, commentIndex).trim();
	}
	return trimmed;
}

function readEnvFile(path: string): Record<string, string> {
	try {
		return parseEnvFile(readFileSync(path, "utf8"));
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			throw new Error(`Environment file not found: ${path}`);
		}
		throw error;
	}
}

function resolveEnvValue(name: string, envFileValues: Record<string, string>): string {
	const fromProcess = process.env[name];
	if (typeof fromProcess === "string" && fromProcess.length > 0) {
		return fromProcess;
	}
	const fromFile = envFileValues[name];
	if (typeof fromFile === "string" && fromFile.length > 0) {
		return fromFile;
	}
	throw new Error(`Missing required token '${name}' in environment or .env file`);
}

function buildSmokeFailureDetails(execution: ParsedHookExecution): string[] {
	const details: string[] = [];
	if (execution.hook?.command) {
		details.push(`command: ${execution.hook.command}`);
	}
	if (execution.error) {
		details.push(`error: ${execution.error}`);
	}
	if (execution.exitCode !== undefined) {
		details.push(`exitCode: ${execution.exitCode === null ? "null" : execution.exitCode}`);
	}
	if (execution.signal) {
		details.push(`signal: ${execution.signal}`);
	}
	if (execution.timedOut) {
		details.push("timedOut: true");
	}
	if (execution.stderr?.trim()) {
		details.push(`stderr: ${execution.stderr.trim()}`);
	}
	if (execution.stdout?.trim()) {
		details.push(`stdout: ${execution.stdout.trim()}`);
	}
	return details;
}

async function runSmokeAdapter(options: {
	adapter: HookAdapter;
	envFilePath: string;
	message?: string;
	env: Record<string, string>;
}): Promise<void> {
	const hook: ResolvedHookDefinition = {
		adapter: options.adapter,
		command: createBundledHookAdapterCommand(options.adapter),
		events: ["workflow:start"],
		timeoutMs: 10_000,
		async: false,
		env: options.env,
	};
	const runner = createHookRunner({ hooks: [hook], cwd: process.cwd() });

	const input: HookInput = {
		event: "workflow:start",
		timestamp: new Date().toISOString(),
		runId: `smoke-${options.adapter}-${Date.now()}`,
		payload: {
			task: options.message ?? `Slice smoke test for ${options.adapter}`,
			slug: `smoke-${options.adapter}`,
		},
	};

	const result = (await runner.run(input)) as ParsedHookRunResult;
	const execution = result.executions[0];
	if (!execution) {
		throw new Error("Smoke hook did not execute");
	}
	if (!execution.success) {
		const details = buildSmokeFailureDetails(execution);
		throw new Error(`Smoke hook failed${details.length > 0 ? `\n${details.join("\n")}` : ""}`);
	}
	console.info(
		`Smoke message sent via ${options.adapter} using ${options.envFilePath.replace(process.cwd(), ".")}`,
	);
}

export function registerSmokeSlackCommand(program: Command): void {
	program
		.command("smoke-slack")
		.description("Send a Slack smoke notification using the bundled adapter")
		.requiredOption("--channel <id>", "Slack channel ID (e.g. C01234ABCDE)")
		.option("--env-file <path>", "Path to .env file", ".env")
		.option("--message <text>", "Optional smoke test message")
		.action(async (options: SmokeSlackOptions) => {
			const envFilePath = resolve(process.cwd(), options.envFile);
			const envFileValues = readEnvFile(envFilePath);
			const token = resolveEnvValue(SLACK_BOT_TOKEN_ENV, envFileValues);
			await runSmokeAdapter({
				adapter: "slack",
				envFilePath,
				message: options.message,
				env: {
					[SLACK_BOT_TOKEN_ENV]: token,
					[SLACK_CHANNEL_ENV]: options.channel,
				},
			});
		});
}

export function registerSmokeTelegramCommand(program: Command): void {
	program
		.command("smoke-telegram")
		.description("Send a Telegram smoke notification using the bundled adapter")
		.requiredOption("--chat-id <id>", "Telegram chat ID (e.g. -100123456789)")
		.option("--env-file <path>", "Path to .env file", ".env")
		.option("--message <text>", "Optional smoke test message")
		.action(async (options: SmokeTelegramOptions) => {
			const envFilePath = resolve(process.cwd(), options.envFile);
			const envFileValues = readEnvFile(envFilePath);
			const token = resolveEnvValue(TELEGRAM_BOT_TOKEN_ENV, envFileValues);
			await runSmokeAdapter({
				adapter: "telegram",
				envFilePath,
				message: options.message,
				env: {
					[TELEGRAM_BOT_TOKEN_ENV]: token,
					[TELEGRAM_CHAT_ID_ENV]: options.chatId,
				},
			});
		});
}

export { parseEnvFile, parseEnvValue };
