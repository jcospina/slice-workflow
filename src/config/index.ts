import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { ZodError } from "zod";
import { globalConfigSchema, projectConfigSchema, resolvedConfigSchema } from "./schema";
import type { GlobalConfig, ProjectConfig, ResolvedConfig } from "./types";

export { globalConfigSchema, projectConfigSchema, resolvedConfigSchema } from "./schema";
export type {
	GlobalConfig,
	ProjectConfig,
	ResolvedConfig,
	ResolvedSlackConfig,
	ResolvedTelegramConfig,
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
		const json = JSON.parse(content);
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
		messaging: resolveMessaging(global.messaging, project.messaging),
		implementationsDir: project.implementationsDir,
		approvalGates: project.approvalGates,
		sliceExecution: project.sliceExecution,
		review: project.review,
	});
}

function resolveMessaging(
	global?: GlobalConfig["messaging"],
	project?: ProjectConfig["messaging"],
): ResolvedConfig["messaging"] {
	const result: ResolvedConfig["messaging"] = {};

	const slack = resolveSlack(global?.slack, project?.slack);
	if (slack) {
		result.slack = slack;
	}

	const telegram = resolveTelegram(global?.telegram, project?.telegram);
	if (telegram) {
		result.telegram = telegram;
	}

	return result;
}

function resolveSlack(
	global?: NonNullable<GlobalConfig["messaging"]>["slack"],
	project?: NonNullable<ProjectConfig["messaging"]>["slack"],
): ResolvedConfig["messaging"]["slack"] | undefined {
	const appToken = project?.appToken ?? global?.appToken;
	const botToken = project?.botToken ?? global?.botToken;
	if (!(appToken && botToken)) {
		return undefined;
	}

	const channel =
		project?.channel ?? global?.channel ?? global?.defaultChannel ?? "#slice-notifications";
	return { appToken, botToken, channel };
}

function resolveTelegram(
	global?: NonNullable<GlobalConfig["messaging"]>["telegram"],
	project?: NonNullable<ProjectConfig["messaging"]>["telegram"],
): ResolvedConfig["messaging"]["telegram"] | undefined {
	const botToken = project?.botToken ?? global?.botToken;
	const chatId = project?.chatId ?? global?.chatId;
	if (!(botToken && chatId)) {
		return undefined;
	}
	return { botToken, chatId };
}

export function loadConfig(cwd?: string): ResolvedConfig {
	const global = loadGlobalConfig();
	const project = loadProjectConfig(cwd);
	return resolveConfig(global, project);
}
