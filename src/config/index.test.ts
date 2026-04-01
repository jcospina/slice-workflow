import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

	it("resolves slack messaging when tokens are in global", () => {
		const global: GlobalConfig = {
			messaging: {
				slack: {
					appToken: "xapp-1-test",
					botToken: "xoxb-test",
					defaultChannel: "#global-channel",
				},
			},
		};
		const result = resolveConfig(global, {});
		expect(result.messaging.slack).toEqual({
			appToken: "xapp-1-test",
			botToken: "xoxb-test",
			channel: "#global-channel",
		});
	});

	it("project slack channel overrides global defaultChannel", () => {
		const global: GlobalConfig = {
			messaging: {
				slack: {
					appToken: "xapp-1-test",
					botToken: "xoxb-test",
					defaultChannel: "#global-channel",
				},
			},
		};
		const project: ProjectConfig = {
			messaging: { slack: { channel: "#project-channel" } },
		};
		const result = resolveConfig(global, project);
		expect(result.messaging.slack?.channel).toBe("#project-channel");
		expect(result.messaging.slack?.appToken).toBe("xapp-1-test");
	});

	it("omits slack when tokens are missing", () => {
		const global: GlobalConfig = {
			messaging: { slack: { defaultChannel: "#no-tokens" } },
		};
		const result = resolveConfig(global, {});
		expect(result.messaging.slack).toBeUndefined();
	});

	it("resolves telegram messaging", () => {
		const global: GlobalConfig = {
			messaging: {
				telegram: { botToken: "123:ABC", chatId: "-100123" },
			},
		};
		const result = resolveConfig(global, {});
		expect(result.messaging.telegram).toEqual({
			botToken: "123:ABC",
			chatId: "-100123",
		});
	});

	it("omits telegram when chatId is missing", () => {
		const global: GlobalConfig = {
			messaging: { telegram: { botToken: "123:ABC" } },
		};
		const result = resolveConfig(global, {});
		expect(result.messaging.telegram).toBeUndefined();
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
				messaging: {
					slack: {
						appToken: "xapp-1",
						botToken: "xoxb-1",
						defaultChannel: "#global",
					},
				},
			}),
		);
		writeFileSync(
			join(tmpDir, ".slicerc"),
			JSON.stringify({
				provider: "claude-code",
				implementationsDir: "my-impl",
				providers: { claudeCode: { command: "klaude" } },
				messaging: { slack: { channel: "#project" } },
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
		expect(result.messaging.slack?.channel).toBe("#project");
		expect(result.messaging.slack?.appToken).toBe("xapp-1");
		expect(result.approvalGates).toEqual({ rfc: true, plan: true });
		expect(result.review.enabled).toBe(true);
	});
});
