import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { ZodError } from "zod";
import { createBundledHookAdapterCommand } from "../hooks/adapters/path";
import { DEFAULT_HOOK_TIMEOUT_MS } from "../hooks/types";
import { globalConfigSchema, projectConfigSchema, resolvedConfigSchema } from "./schema";
import type { GlobalConfig, HookDefinition, ProjectConfig, ResolvedConfig } from "./types";

export { globalConfigSchema, projectConfigSchema, resolvedConfigSchema } from "./schema";
export type {
	GlobalConfig,
	HookDefinition,
	HookEvent,
	HookInput,
	HookOutput,
	ProjectConfig,
	ResolvedConfig,
	ResolvedHookDefinition,
	Provider,
	SliceExecution,
	SeverityLevel,
} from "./types";

const GLOBAL_CONFIG_PATH = join(homedir(), ".slice", "config.json");
const PROJECT_CONFIG_FILE = ".slicerc";

export const DEFAULTS: ResolvedConfig = resolvedConfigSchema.parse({});

function loadJsonFile<T>(path: string, schema: z.ZodType<T>): T {
	try {
		const content = readFileSync(path, "utf-8");
		const json = JSON.parse(content) as unknown;
		assertMessagingRemoved(path, json);
		return schema.parse(json);
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return schema.parse({});
		}
		if (error instanceof ZodError) {
			const details = error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
			throw new Error(`Invalid config at ${path}:\n${details}`);
		}
		if (error instanceof SyntaxError) {
			throw new Error(`Invalid JSON in ${path}: ${error.message}`);
		}
		throw error;
	}
}

function assertMessagingRemoved(path: string, value: unknown): void {
	if (isRecord(value) && "messaging" in value) {
		throw new Error(
			`Invalid config at ${path}:\n  - messaging: 'messaging' has been removed. Use hooks[].adapter with envFrom instead.`,
		);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function loadGlobalConfig(path: string = GLOBAL_CONFIG_PATH): GlobalConfig {
	return loadJsonFile(path, globalConfigSchema);
}

export function loadProjectConfig(cwd: string = process.cwd()): ProjectConfig {
	return loadJsonFile(join(cwd, PROJECT_CONFIG_FILE), projectConfigSchema);
}

export function resolveConfig(global: GlobalConfig, project: ProjectConfig): ResolvedConfig {
	return resolvedConfigSchema.parse({
		provider: project.provider ?? global.defaultProvider,
		providers: {
			claudeCode: { ...global.providers?.claudeCode, ...project.providers?.claudeCode },
			opencode: { ...global.providers?.opencode, ...project.providers?.opencode },
		},
		hooks: resolveHooks(global.hooks, project.hooks),
		implementationsDir: project.implementationsDir,
		approvalGates: project.approvalGates,
		sliceExecution: project.sliceExecution,
		execution: project.execution,
		review: project.review,
		retry: project.retry,
	});
}

function resolveHooks(
	global?: GlobalConfig["hooks"],
	project?: ProjectConfig["hooks"],
): ResolvedConfig["hooks"] {
	return [...(global ?? []), ...(project ?? [])].map((hook) => {
		const command = resolveHookCommand(hook);
		const env = resolveHookEnv(hook.envFrom);
		return {
			...hook,
			command,
			env,
			timeoutMs: hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
			async: hook.async ?? Boolean(hook.adapter),
		};
	});
}

function resolveHookCommand(hook: HookDefinition): string {
	if (hook.command) {
		return hook.command;
	}
	if (hook.adapter) {
		return createBundledHookAdapterCommand(hook.adapter);
	}
	// Config schema prevents this state.
	throw new Error("Invalid hook definition: missing command and adapter");
}

function resolveHookEnv(envFrom?: Record<string, string>): Record<string, string> | undefined {
	if (!envFrom) {
		return undefined;
	}
	const env: Record<string, string> = {};
	for (const [targetVar, sourceVar] of Object.entries(envFrom)) {
		const value = process.env[sourceVar];
		if (typeof value === "string") {
			env[targetVar] = value;
		}
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

export function loadConfig(cwd?: string): ResolvedConfig {
	const global = loadGlobalConfig();
	const project = loadProjectConfig(cwd);
	return resolveConfig(global, project);
}
