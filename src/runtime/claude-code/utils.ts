import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ResolvedConfig } from "../../config/types";
import { RuntimeError } from "../../utils/errors";
import type { AgentInteractiveOptions, AgentRunOptions, AgentRunResult } from "../types";

export type ClaudeCodeRuntimeConfig = ResolvedConfig["providers"]["claudeCode"];

export interface ClaudeCliInvocation {
	command: string;
	args: string[];
	cwd: string;
	method: "run" | "runInteractive";
	stdio?: "inherit" | "pipe";
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

export interface ClaudeCliProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

export async function buildAutonomousPrompt(
	options: AgentRunOptions,
	provider: string,
): Promise<string> {
	const sections: string[] = [];
	const contextSections = await readContextSections(
		options.contextFiles,
		options.cwd,
		provider,
		"run",
	);

	if (options.systemPrompt?.trim()) {
		sections.push(`System instructions:\n${options.systemPrompt.trim()}`);
	}

	if (contextSections.length > 0) {
		sections.push(contextSections.join("\n\n"));
	}

	sections.push(`Task:\n${options.prompt.trim()}`);

	return sections.join("\n\n");
}

export async function buildInteractivePrompt(
	options: AgentInteractiveOptions,
	provider: string,
): Promise<string> {
	const sections = await readContextSections(
		options.contextFiles,
		options.cwd,
		provider,
		"runInteractive",
	);

	if (options.prompt?.trim()) {
		sections.push(`Task:\n${options.prompt.trim()}`);
	}

	return sections.join("\n\n");
}

export function buildClaudeArgs(
	prompt: string,
	config: ClaudeCodeRuntimeConfig,
	options: Pick<AgentRunOptions, "allowedTools" | "maxTurns">,
): string[] {
	const args: string[] = [];

	if (config.model) {
		args.push("--model", config.model);
	}

	if (options.maxTurns !== undefined) {
		args.push("--max-turns", String(options.maxTurns));
	}

	const allowedTools = normalizeAllowedTools(options.allowedTools);

	if (allowedTools !== undefined && allowedTools.length > 0) {
		args.push("--allowedTools", allowedTools.join(","));
	}

	args.push("-p", prompt);

	return args;
}

export function buildInteractiveClaudeArgs(options: {
	config: ClaudeCodeRuntimeConfig;
	prompt: string;
	sessionId: string;
	systemPrompt?: string;
}): string[] {
	const args: string[] = [];

	if (options.config.model) {
		args.push("--model", options.config.model);
	}

	args.push("--session-id", options.sessionId);

	if (options.systemPrompt?.trim()) {
		args.push("--append-system-prompt", options.systemPrompt.trim());
	}

	if (options.prompt.trim()) {
		args.push(options.prompt);
	}

	return args;
}

function normalizeAllowedTools(allowedTools: string[] | undefined): string[] | undefined {
	return allowedTools?.map((tool) => tool.trim()).filter((tool) => tool.length > 0);
}

export function normalizeRunResult(
	execution: ClaudeCliProcessResult,
	durationMs: number,
	sessionId: string,
): AgentRunResult {
	const output = combineOutput(execution.stdout, execution.stderr);
	const success = execution.exitCode === 0 && execution.signal === null;

	if (success) {
		return {
			success: true,
			output,
			sessionId,
			costUsd: 0,
			durationMs,
		};
	}

	const error = buildFailureMessage(execution.exitCode, execution.signal, execution.stderr);

	return {
		success: false,
		output: output || error,
		sessionId,
		costUsd: 0,
		durationMs,
		error,
	};
}

export async function runClaudeCli(
	invocation: ClaudeCliInvocation,
	provider = "claude-code",
): Promise<ClaudeCliProcessResult> {
	return await new Promise((resolvePromise, rejectPromise) => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		let settled = false;
		const stdio = invocation.stdio ?? "pipe";

		const child = spawn(invocation.command, invocation.args, {
			cwd: invocation.cwd,
			stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
		});

		if (stdio === "pipe") {
			child.stdout?.on("data", (chunk: Buffer | string) => {
				const text = chunk.toString();
				stdout.push(text);
				invocation.onStdout?.(text);
			});

			child.stderr?.on("data", (chunk: Buffer | string) => {
				const text = chunk.toString();
				stderr.push(text);
				invocation.onStderr?.(text);
			});
		}

		child.once("error", (error) => {
			if (settled) {
				return;
			}

			const launchError = error as NodeJS.ErrnoException;
			settled = true;
			rejectPromise(
				new RuntimeError(buildLaunchFailureMessage(launchError, invocation.command), {
					provider,
					method: invocation.method,
					command: invocation.command,
					cwd: invocation.cwd,
					code: launchError.code,
					cause: error,
				}),
			);
		});

		child.once("close", (exitCode, signal) => {
			if (settled) {
				return;
			}

			settled = true;
			resolvePromise({
				stdout: stdout.join(""),
				stderr: stderr.join(""),
				exitCode,
				signal,
			});
		});
	});
}

async function readContextSections(
	contextFiles: string[] | undefined,
	cwd: string,
	provider: string,
	method: "run" | "runInteractive",
): Promise<string[]> {
	if (contextFiles === undefined || contextFiles.length === 0) {
		return [];
	}

	return await Promise.all(
		contextFiles.map(async (contextFile) => {
			const resolvedPath = resolve(cwd, contextFile);

			try {
				const content = await readFile(resolvedPath, "utf-8");
				return `Context file: ${resolvedPath}\n${content}`;
			} catch (error) {
				throw new RuntimeError(`Failed to read context file '${contextFile}'.`, {
					provider,
					method,
					path: resolvedPath,
					cause: error,
				});
			}
		}),
	);
}

function combineOutput(stdout: string, stderr: string): string {
	return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n");
}

function buildLaunchFailureMessage(error: NodeJS.ErrnoException, command: string): string {
	if (error.code === "ENOENT") {
		return `Claude CLI command '${command}' was not found. Install the Claude CLI, ensure '${command}' is available on PATH, and authenticate it before using the claude-code runtime.`;
	}

	if (error.code === "EACCES") {
		return `Claude CLI command '${command}' is not executable. Check the configured command path and permissions, then retry.`;
	}

	return `Failed to launch Claude CLI command '${command}': ${error.message}`;
}

function buildFailureMessage(
	exitCode: number | null,
	signal: NodeJS.Signals | null,
	stderr: string,
): string {
	const normalizedStderr = stderr.trim();

	if (normalizedStderr) {
		return normalizedStderr;
	}

	if (signal) {
		return `Claude CLI terminated with signal ${signal}.`;
	}

	return `Claude CLI exited with code ${exitCode ?? "unknown"}.`;
}
