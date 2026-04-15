import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HOOK_TIMEOUT_MS } from "../hooks/types";

vi.mock("../hooks/adapters/path", () => ({
	createBundledHookAdapterCommand: vi.fn((adapter: string) => `bundled:${adapter}`),
}));
import { DEFAULTS, loadGlobalConfig, loadProjectConfig, resolveConfig } from "./index";
import type { GlobalConfig, ProjectConfig } from "./types";

// --- resolveConfig (pure merge logic, no filesystem) ---

describe("resolveConfig", () => {
	it("returns defaults when both configs are empty", () => {
		const result = resolveConfig({}, {});
		expect(result).toEqual(DEFAULTS);
	});

	it("uses global defaultProvider when project has no provider", () => {
		const global: GlobalConfig = { defaultProvider: "opencode" };
		const result = resolveConfig(global, {});
		expect(result.provider).toBe("opencode");
	});

	it("project provider overrides global defaultProvider", () => {
		const global: GlobalConfig = { defaultProvider: "opencode" };
		const project: ProjectConfig = { provider: "claude-code" };
		const result = resolveConfig(global, project);
		expect(result.provider).toBe("claude-code");
	});

	it("merges provider model configs with project taking precedence", () => {
		const global: GlobalConfig = {
			providers: {
				claudeCode: { model: "sonnet", command: "maude" },
				opencode: { model: "gpt-4o", command: "opencode-work" },
			},
		};
		const project: ProjectConfig = {
			providers: {
				claudeCode: { command: "klaude" },
				opencode: { model: "ollama/qwen2.5-coder:32b", command: "opencode-personal" },
			},
		};
		const result = resolveConfig(global, project);
		expect(result.providers.claudeCode.model).toBe("sonnet");
		expect(result.providers.claudeCode.command).toBe("klaude");
		expect(result.providers.opencode.model).toBe("ollama/qwen2.5-coder:32b");
		expect(result.providers.opencode.command).toBe("opencode-personal");
	});

	it("merges maxTurns for both providers with project taking precedence", () => {
		const global: GlobalConfig = {
			providers: {
				claudeCode: { maxTurns: 20 },
				opencode: { maxTurns: 15 },
			},
		};
		const project: ProjectConfig = {
			providers: {
				claudeCode: { maxTurns: 10 },
			},
		};
		const result = resolveConfig(global, project);
		expect(result.providers.claudeCode.maxTurns).toBe(10);
		expect(result.providers.opencode.maxTurns).toBe(15);
	});

	it("leaves maxTurns undefined when not configured", () => {
		const result = resolveConfig({}, {});
		expect(result.providers.claudeCode.maxTurns).toBeUndefined();
		expect(result.providers.opencode.maxTurns).toBeUndefined();
	});

	it("applies execution defaults when not configured", () => {
		const result = resolveConfig({}, {});
		expect(result.execution.maxTurnsPerSlice).toBe(50);
		expect(result.execution.maxTurnsPerReview).toBe(20);
	});

	it("uses project execution values when configured", () => {
		const project: ProjectConfig = {
			execution: { maxTurnsPerSlice: 30, maxTurnsPerReview: 10 },
		};
		const result = resolveConfig({}, project);
		expect(result.execution.maxTurnsPerSlice).toBe(30);
		expect(result.execution.maxTurnsPerReview).toBe(10);
	});

	it("resolves hooks to an empty array when omitted", () => {
		const result = resolveConfig({}, {});
		expect(result.hooks).toEqual([]);
	});

	it("merges hooks by appending project hooks after global hooks", () => {
		const global: GlobalConfig = {
			hooks: [
				{ command: "global-complete", events: ["workflow:complete"] },
				{ command: "global-failed", events: ["workflow:failed"], timeoutMs: 9_000 },
			],
		};
		const project: ProjectConfig = {
			hooks: [{ command: "project-failed", events: ["slice:failed"] }],
		};

		const result = resolveConfig(global, project);

		expect(result.hooks.map((hook) => hook.command)).toEqual([
			"global-complete",
			"global-failed",
			"project-failed",
		]);
		expect(result.hooks[0].timeoutMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
		expect(result.hooks[1].timeoutMs).toBe(9_000);
		expect(result.hooks[2].timeoutMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
	});

	it("resolves adapter hooks to bundled commands and defaults async=true", () => {
		const global: GlobalConfig = {
			hooks: [{ adapter: "slack", events: ["workflow:failed"] }],
		};

		const result = resolveConfig(global, {});

		expect(result.hooks).toHaveLength(1);
		expect(result.hooks[0]?.command).toBe("bundled:slack");
		expect(result.hooks[0]?.async).toBe(true);
	});

	it("resolves envFrom mappings from process.env", () => {
		const previous = process.env.SLICEWORKF_TEST_TOKEN;
		process.env.SLICEWORKF_TEST_TOKEN = "token-from-env";
		try {
			const result = resolveConfig(
				{
					hooks: [
						{
							command: "echo hook",
							events: ["workflow:failed"],
							// biome-ignore lint/style/useNamingConvention: env vars are uppercase by convention.
							envFrom: { SLACK_BOT_TOKEN: "SLICEWORKF_TEST_TOKEN" },
						},
					],
				},
				{},
			);

			// biome-ignore lint/style/useNamingConvention: env vars are uppercase by convention.
			expect(result.hooks[0]?.env).toEqual({ SLACK_BOT_TOKEN: "token-from-env" });
		} finally {
			if (previous === undefined) {
				process.env.SLICEWORKF_TEST_TOKEN = undefined;
			} else {
				process.env.SLICEWORKF_TEST_TOKEN = previous;
			}
		}
	});

	it("applies project overrides for all scalar fields", () => {
		const project: ProjectConfig = {
			implementationsDir: "custom-dir",
			sliceExecution: "gated",
			approvalGates: { rfc: false, plan: false },
			review: {
				enabled: false,
				maxIterations: 5,
				severityThreshold: "critical",
				reviewProvider: "opencode",
			},
		};
		const result = resolveConfig({}, project);
		expect(result.implementationsDir).toBe("custom-dir");
		expect(result.sliceExecution).toBe("gated");
		expect(result.approvalGates).toEqual({ rfc: false, plan: false });
		expect(result.review).toEqual({
			enabled: false,
			maxIterations: 5,
			severityThreshold: "critical",
			reviewProvider: "opencode",
		});
	});

	it("partially overrides approval gates", () => {
		const project: ProjectConfig = {
			approvalGates: { rfc: false },
		};
		const result = resolveConfig({}, project);
		expect(result.approvalGates).toEqual({ rfc: false, plan: true });
	});
});

// --- File loading (uses temp directories) ---

describe("loadGlobalConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "slice-config-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty config when file is missing", () => {
		const result = loadGlobalConfig(join(tmpDir, "config.json"));
		expect(result).toEqual({});
	});

	it("loads and validates a valid global config", () => {
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				defaultProvider: "claude-code",
				providers: { claudeCode: { model: "sonnet", command: "klaude" } },
			}),
		);
		const result = loadGlobalConfig(configPath);
		expect(result.defaultProvider).toBe("claude-code");
		expect(result.providers?.claudeCode?.model).toBe("sonnet");
		expect(result.providers?.claudeCode?.command).toBe("klaude");
	});

	it("throws on invalid JSON", () => {
		const configPath = join(tmpDir, "config.json");
		writeFileSync(configPath, "{ broken json }");
		expect(() => loadGlobalConfig(configPath)).toThrow("Invalid JSON");
	});

	it("throws on invalid config values with field details", () => {
		const configPath = join(tmpDir, "config.json");
		writeFileSync(configPath, JSON.stringify({ defaultProvider: "invalid" }));
		expect(() => loadGlobalConfig(configPath)).toThrow("Invalid config");
	});

	it("throws when legacy messaging config is present", () => {
		const configPath = join(tmpDir, "config.json");
		writeFileSync(configPath, JSON.stringify({ messaging: { slack: { botToken: "xoxb-1" } } }));
		expect(() => loadGlobalConfig(configPath)).toThrow("messaging");
	});

	it("throws when hooks include an unknown lifecycle event", () => {
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				hooks: [{ command: "notify", events: ["workflow:unknown"] }],
			}),
		);
		expect(() => loadGlobalConfig(configPath)).toThrow("Invalid config");
	});

	it("throws when hooks include an empty events array", () => {
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				hooks: [{ command: "notify", events: [] }],
			}),
		);
		expect(() => loadGlobalConfig(configPath)).toThrow("Invalid config");
	});

	it("throws when a hook defines both command and adapter", () => {
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				hooks: [{ command: "notify", adapter: "slack", events: ["workflow:failed"] }],
			}),
		);
		expect(() => loadGlobalConfig(configPath)).toThrow("exactly one");
	});

	it("throws when hook timeout is non-positive", () => {
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				hooks: [{ command: "notify", events: ["workflow:failed"], timeoutMs: 0 }],
			}),
		);
		expect(() => loadGlobalConfig(configPath)).toThrow("Invalid config");
	});

	it("throws when hook timeout is not an integer", () => {
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				hooks: [{ command: "notify", events: ["workflow:failed"], timeoutMs: 1.5 }],
			}),
		);
		expect(() => loadGlobalConfig(configPath)).toThrow("Invalid config");
	});

	it("throws when hook matcher is an invalid regex", () => {
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				hooks: [{ command: "notify", events: ["workflow:failed"], matcher: "(" }],
			}),
		);
		expect(() => loadGlobalConfig(configPath)).toThrow("Invalid config");
	});
});

describe("loadProjectConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "slice-project-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty config when .slicerc is missing", () => {
		const result = loadProjectConfig(tmpDir);
		expect(result).toEqual({});
	});

	it("loads a valid project config", () => {
		writeFileSync(
			join(tmpDir, ".slicerc"),
			JSON.stringify({
				provider: "opencode",
				implementationsDir: "impl",
				sliceExecution: "gated",
			}),
		);
		const result = loadProjectConfig(tmpDir);
		expect(result.provider).toBe("opencode");
		expect(result.implementationsDir).toBe("impl");
		expect(result.sliceExecution).toBe("gated");
	});

	it("throws on invalid project config", () => {
		writeFileSync(join(tmpDir, ".slicerc"), JSON.stringify({ sliceExecution: "parallel" }));
		expect(() => loadProjectConfig(tmpDir)).toThrow("Invalid config");
	});

	it("throws when legacy project messaging config is present", () => {
		writeFileSync(join(tmpDir, ".slicerc"), JSON.stringify({ messaging: { telegram: {} } }));
		expect(() => loadProjectConfig(tmpDir)).toThrow("messaging");
	});

	it("throws when project hook command is missing", () => {
		writeFileSync(
			join(tmpDir, ".slicerc"),
			JSON.stringify({
				hooks: [{ events: ["workflow:complete"] }],
			}),
		);
		expect(() => loadProjectConfig(tmpDir)).toThrow("Invalid config");
	});

	it("accepts project adapter-only hooks", () => {
		writeFileSync(
			join(tmpDir, ".slicerc"),
			JSON.stringify({
				hooks: [{ adapter: "telegram", events: ["workflow:failed"] }],
			}),
		);
		const result = loadProjectConfig(tmpDir);
		expect(result.hooks?.[0]?.adapter).toBe("telegram");
	});

	it("throws when project hook command is empty", () => {
		writeFileSync(
			join(tmpDir, ".slicerc"),
			JSON.stringify({
				hooks: [{ command: "  ", events: ["workflow:complete"] }],
			}),
		);
		expect(() => loadProjectConfig(tmpDir)).toThrow("Invalid config");
	});
});

// --- Full integration: load + resolve ---

describe("loadConfig end-to-end", () => {
	let tmpDir: string;
	let globalDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "slice-e2e-test-"));
		globalDir = mkdtempSync(join(tmpdir(), "slice-global-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	});

	it("merges global and project configs with defaults", () => {
		const globalPath = join(globalDir, "config.json");
		writeFileSync(
			globalPath,
			JSON.stringify({
				defaultProvider: "opencode",
				providers: { opencode: { model: "gpt-4o", command: "opencode-work" } },
				hooks: [{ command: "global-hook", events: ["workflow:failed"] }],
			}),
		);
		writeFileSync(
			join(tmpDir, ".slicerc"),
			JSON.stringify({
				provider: "claude-code",
				implementationsDir: "my-impl",
				providers: { claudeCode: { command: "klaude" } },
				hooks: [{ adapter: "slack", events: ["workflow:complete"] }],
			}),
		);

		const global = loadGlobalConfig(globalPath);
		const project = loadProjectConfig(tmpDir);
		const result = resolveConfig(global, project);

		expect(result.provider).toBe("claude-code");
		expect(result.providers.opencode.model).toBe("gpt-4o");
		expect(result.providers.opencode.command).toBe("opencode-work");
		expect(result.providers.claudeCode.command).toBe("klaude");
		expect(result.implementationsDir).toBe("my-impl");
		expect(result.hooks).toHaveLength(2);
		expect(result.hooks[0]?.command).toBe("global-hook");
		expect(result.hooks[1]?.command).toBe("bundled:slack");
		expect(result.approvalGates).toEqual({ rfc: true, plan: true });
		expect(result.review.enabled).toBe(true);
	});
});
