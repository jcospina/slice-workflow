import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { RuntimeError } from "../../utils/errors";
import type { AgentInteractiveOptions, AgentRunOptions, AgentRunResult } from "../types";
import { OPENCODE_SERVER_BASE_URL } from "./serve-manager";
import type {
	OpenCodeApiResult,
	OpenCodeAssistantError,
	OpenCodeCliInvocation,
	OpenCodeCliProcessResult,
	OpenCodeModel,
	OpenCodePermissionEvent,
	OpenCodePromptMessage,
	OpenCodePromptPart,
	OpenCodeSession,
	OpenCodeSessionClient,
} from "./types";

const NEWLINE_SPLIT_PATTERN = /\r?\n/u;
const SESSION_ID_API_KEY = "sessionID";
const PROVIDER_ID_API_KEY = "providerID";
const MODEL_ID_API_KEY = "modelID";
const PERMISSION_ID_API_KEY = "permissionID";

export async function runOpenCodeCli(
	invocation: OpenCodeCliInvocation,
	provider = "opencode",
): Promise<OpenCodeCliProcessResult> {
	return await new Promise((resolvePromise, rejectPromise) => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		let settled = false;
		const stdio = invocation.stdio ?? "pipe";
		const rejectLaunchError = (error: unknown) => {
			if (settled) {
				return;
			}

			const launchError = error as NodeJS.ErrnoException;
			settled = true;
			rejectPromise(
				new RuntimeError(buildCliLaunchFailureMessage(launchError, invocation.command), {
					provider,
					method: invocation.method,
					command: invocation.command,
					cwd: invocation.cwd,
					code: launchError.code,
					cause: error,
				}),
			);
		};

		let child: ReturnType<typeof spawn>;

		try {
			child = spawn(invocation.command, invocation.args, {
				cwd: invocation.cwd,
				stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			rejectLaunchError(error);
			return;
		}

		if (stdio === "pipe") {
			child.stdout?.on("data", (chunk: Buffer | string) => {
				stdout.push(chunk.toString());
			});

			child.stderr?.on("data", (chunk: Buffer | string) => {
				stderr.push(chunk.toString());
			});
		}

		child.once("error", rejectLaunchError);

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

export function normalizeInteractiveRunResult(
	execution: OpenCodeCliProcessResult,
	durationMs: number,
	sessionId: string,
): AgentRunResult {
	const output = combineCliOutput(execution.stdout, execution.stderr);
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

	const error = buildCliFailureMessage(execution.exitCode, execution.signal, execution.stderr);

	return {
		success: false,
		output: output || error,
		sessionId,
		costUsd: 0,
		durationMs,
		error,
	};
}

export function createDefaultOpenCodeClient(cwd: string): OpenCodeSessionClient {
	const client = createOpencodeClient({
		baseUrl: OPENCODE_SERVER_BASE_URL,
		directory: cwd,
	});

	return {
		session: {
			create: async (options) =>
				normalizeApiResult(
					(await client.session.create({
						query: { directory: options.query.directory },
						body: options.body,
					})) as OpenCodeApiResult<unknown>,
					normalizeSession,
				),
			prompt: async (options) =>
				normalizeApiResult(
					(await client.session.prompt({
						path: { id: options.path.id },
						query: { directory: options.query.directory },
						body: {
							parts: options.body.parts,
							system: options.body.system,
							model: options.body.model
								? {
										[PROVIDER_ID_API_KEY]: options.body.model.providerId,
										[MODEL_ID_API_KEY]: options.body.model.modelId,
									}
								: undefined,
							tools: options.body.tools,
						},
					})) as OpenCodeApiResult<unknown>,
					normalizePromptMessage,
				),
		},
		event: {
			subscribe: async (options) => {
				const subscription = await client.event.subscribe({
					query: { directory: options.query.directory },
					signal: options.signal,
				});

				return {
					stream: normalizePermissionEvents(subscription.stream as AsyncIterable<unknown>),
				};
			},
		},
		postSessionIdPermissionsPermissionId: async (options) =>
			normalizeApiResult(
				(await client.postSessionIdPermissionsPermissionId({
					path: {
						id: options.path.id,
						[PERMISSION_ID_API_KEY]: options.path.permissionId,
					},
					query: { directory: options.query.directory },
					body: options.body,
				})) as OpenCodeApiResult<unknown>,
				(value) => Boolean(value),
			),
	};
}

export function unwrapApiResult<T>(
	response: OpenCodeApiResult<T>,
	message: string,
	provider: "opencode",
	method: "run",
): T {
	if (response.data !== undefined) {
		return response.data;
	}

	throw new RuntimeError(`${message} ${extractErrorMessage(response.error)}`, {
		provider,
		method,
		cause: response.error,
	});
}

export function normalizePromptResult(
	promptResult: OpenCodePromptMessage,
	durationMs: number,
	fallbackSessionId: string,
): AgentRunResult {
	const output = extractOutput(promptResult.parts);
	const sessionId = normalizeOptionalText(promptResult.info.sessionId) ?? fallbackSessionId;
	const costUsd = normalizeCost(promptResult.info.cost);
	const error = promptResult.info.error
		? extractAssistantErrorMessage(promptResult.info.error)
		: undefined;

	if (error) {
		return {
			success: false,
			output: output || error,
			sessionId,
			costUsd,
			durationMs,
			error,
		};
	}

	return {
		success: true,
		output,
		sessionId,
		costUsd,
		durationMs,
	};
}

export function parseConfiguredModel(model: string | undefined): OpenCodeModel | undefined {
	const normalized = normalizeOptionalText(model);

	if (!normalized) {
		return undefined;
	}

	const separatorIndex = normalized.indexOf("/");

	if (separatorIndex <= 0 || separatorIndex >= normalized.length - 1) {
		return undefined;
	}

	return {
		providerId: normalized.slice(0, separatorIndex),
		modelId: normalized.slice(separatorIndex + 1),
	};
}

export function buildToolsMap(
	allowedTools: string[] | undefined,
): Record<string, boolean> | undefined {
	if (!allowedTools || allowedTools.length === 0) {
		return undefined;
	}

	const cleanedTools = allowedTools.map((tool) => tool.trim()).filter((tool) => tool.length > 0);

	if (cleanedTools.length === 0) {
		return undefined;
	}

	return Object.fromEntries(cleanedTools.map((tool) => [tool, true]));
}

export async function buildInteractivePrompt(
	options: AgentInteractiveOptions,
	provider: "opencode",
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

export async function buildAutonomousPrompt(
	options: AgentRunOptions,
	provider: "opencode",
): Promise<string> {
	const sections: string[] = [];
	const contextSections = await readContextSections(
		options.contextFiles,
		options.cwd,
		provider,
		"run",
	);

	if (contextSections.length > 0) {
		sections.push(contextSections.join("\n\n"));
	}

	sections.push(`Task:\n${options.prompt.trim()}`);

	return sections.join("\n\n");
}

export function buildInteractiveOpenCodeArgs(options: {
	model?: string;
	prompt?: string;
	systemPrompt?: string;
}): string[] {
	const args: string[] = [];

	if (options.model?.trim()) {
		args.push("--model", options.model.trim());
	}

	const promptSections: string[] = [];

	if (options.systemPrompt?.trim()) {
		promptSections.push(`System instructions:\n${options.systemPrompt.trim()}`);
	}

	if (options.prompt?.trim()) {
		promptSections.push(options.prompt.trim());
	}

	const combinedPrompt = promptSections.join("\n\n");

	if (combinedPrompt.length > 0) {
		args.push("--prompt", combinedPrompt);
	}

	return args;
}

export function buildSessionTitle(prompt: string): string | undefined {
	const firstLine = prompt
		.trim()
		.split(NEWLINE_SPLIT_PATTERN, 1)
		.map((line) => line.trim())[0];

	if (!firstLine) {
		return undefined;
	}

	return firstLine.slice(0, 120);
}

export function startPermissionAutoResponder(options: {
	client: OpenCodeSessionClient;
	cwd: string;
	sessionId: string;
}): { stop: () => Promise<void> } {
	const controller = new AbortController();
	const consumeStream = (async () => {
		try {
			const stream = (
				await options.client.event.subscribe({
					query: { directory: options.cwd },
					signal: controller.signal,
				})
			).stream;

			for await (const event of stream) {
				const permissionId = extractPermissionRequestId(event, options.sessionId);

				if (!permissionId) {
					continue;
				}

				await options.client.postSessionIdPermissionsPermissionId({
					path: {
						id: options.sessionId,
						permissionId,
					},
					query: { directory: options.cwd },
					body: { response: "once" },
				});
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				throw error;
			}
		}
	})();

	return {
		stop: async () => {
			controller.abort();
			await consumeStream.catch(() => undefined);
		},
	};
}

export function extractErrorMessage(error: unknown): string {
	if (error instanceof RuntimeError) {
		return error.message;
	}

	if (error instanceof Error) {
		return error.message;
	}

	if (typeof error === "string") {
		return error;
	}

	if (error && typeof error === "object") {
		const possibleMessage = normalizeOptionalText(
			(error as { data?: { message?: string } }).data?.message,
		);

		if (possibleMessage) {
			return possibleMessage;
		}
	}

	return "OpenCode runtime run() failed due to an unknown error.";
}

function combineCliOutput(stdout: string, stderr: string): string {
	return [stdout.trim(), stderr.trim()].filter((chunk) => chunk.length > 0).join("\n\n");
}

function buildCliLaunchFailureMessage(error: NodeJS.ErrnoException, command: string): string {
	if (error.code === "ENOENT") {
		return `OpenCode CLI command '${command}' was not found. Install OpenCode, ensure '${command}' is available on PATH, and retry.`;
	}

	if (error.code === "EACCES") {
		return `OpenCode CLI command '${command}' is not executable. Check the configured command path and permissions, then retry.`;
	}

	return `Failed to launch OpenCode CLI command '${command}': ${error.message}`;
}

function buildCliFailureMessage(
	exitCode: number | null,
	signal: NodeJS.Signals | null,
	stderr: string,
): string {
	const normalizedStderr = stderr.trim();

	if (normalizedStderr) {
		return normalizedStderr;
	}

	if (signal) {
		return `OpenCode CLI terminated with signal ${signal}.`;
	}

	return `OpenCode CLI exited with code ${exitCode ?? "unknown"}.`;
}

function extractOutput(parts: OpenCodePromptPart[]): string {
	return parts
		.filter((part) => part.type === "text")
		.map((part) => part.text?.trim() ?? "")
		.filter((part) => part.length > 0)
		.join("\n\n");
}

function normalizeCost(cost: number | undefined): number {
	return Number.isFinite(cost) ? Number(cost) : 0;
}

async function readContextSections(
	contextFiles: string[] | undefined,
	cwd: string,
	provider: "opencode",
	method: "run" | "runInteractive",
): Promise<string[]> {
	if (!contextFiles || contextFiles.length === 0) {
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

function extractPermissionRequestId(
	event: OpenCodePermissionEvent,
	sessionId: string,
): string | undefined {
	if (event.type !== "permission.updated" && event.type !== "permission.asked") {
		return undefined;
	}

	if (event.properties?.sessionId !== sessionId) {
		return undefined;
	}

	return normalizeOptionalText(event.properties.id);
}

function extractAssistantErrorMessage(error: OpenCodeAssistantError): string {
	const detailedMessage = normalizeOptionalText(error.data?.message);

	if (detailedMessage) {
		return detailedMessage;
	}

	const errorName = normalizeOptionalText(error.name);

	if (errorName) {
		return `OpenCode session failed with ${errorName}.`;
	}

	return "OpenCode session failed.";
}

function normalizeOptionalText(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeApiResult<Input, Output>(
	response: OpenCodeApiResult<Input>,
	normalizeData: (data: Input) => Output,
): OpenCodeApiResult<Output> {
	if (response.data === undefined) {
		return { error: response.error };
	}

	try {
		return { data: normalizeData(response.data) };
	} catch (error) {
		return { error };
	}
}

function normalizeSession(data: unknown): OpenCodeSession {
	const record = asRecord(data);

	return {
		id: readRequiredString(record, "id"),
	};
}

function normalizePromptMessage(data: unknown): OpenCodePromptMessage {
	const record = asRecord(data);
	const info = asRecord(record.info);
	const parts = Array.isArray(record.parts) ? record.parts.map(normalizePromptPart) : [];

	return {
		info: {
			sessionId: readOptionalString(info, SESSION_ID_API_KEY),
			cost: readOptionalNumber(info, "cost"),
			error: normalizeAssistantError(info.error),
		},
		parts,
	};
}

function normalizePromptPart(part: unknown): OpenCodePromptPart {
	const record = asRecord(part);

	return {
		type: readRequiredString(record, "type"),
		text: readOptionalString(record, "text"),
	};
}

function normalizeAssistantError(value: unknown): OpenCodeAssistantError | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}

	const record = asRecord(value);
	const data = asRecord(record.data);
	const message = readOptionalString(data, "message");
	const name = readOptionalString(record, "name");

	if (!(message || name)) {
		return undefined;
	}

	return {
		name,
		data: message ? { message } : undefined,
	};
}

function normalizePermissionEvents(
	stream: AsyncIterable<unknown>,
): AsyncIterable<OpenCodePermissionEvent> {
	return {
		async *[Symbol.asyncIterator]() {
			for await (const event of stream) {
				yield normalizePermissionEvent(event);
			}
		},
	};
}

function normalizePermissionEvent(event: unknown): OpenCodePermissionEvent {
	const record = asRecord(event);
	const properties = asRecord(record.properties);

	return {
		type: readOptionalString(record, "type"),
		properties: {
			sessionId: readOptionalString(properties, SESSION_ID_API_KEY),
			id: readOptionalString(properties, "id"),
		},
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object") {
		return value as Record<string, unknown>;
	}

	return {};
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" ? value : undefined;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
	const value = readOptionalString(record, key);

	if (!value) {
		throw new RuntimeError(`OpenCode SDK response did not include '${key}'.`, {
			provider: "opencode",
			method: "run",
		});
	}

	return value;
}
