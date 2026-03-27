import type { z } from "zod";
import type {
	globalConfigSchema,
	projectConfigSchema,
	providerEnum,
	resolvedConfigSchema,
	severityEnum,
	sliceExecutionEnum,
} from "./schema";

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type ResolvedConfig = z.infer<typeof resolvedConfigSchema>;

export type Provider = z.infer<typeof providerEnum>;
export type SliceExecution = z.infer<typeof sliceExecutionEnum>;
export type SeverityLevel = z.infer<typeof severityEnum>;

export type ResolvedSlackConfig = NonNullable<ResolvedConfig["messaging"]["slack"]>;
export type ResolvedTelegramConfig = NonNullable<ResolvedConfig["messaging"]["telegram"]>;
