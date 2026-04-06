import { describe, expect, it } from "vitest";
import { RuntimeError } from "../utils/errors";
import { ClaudeCodeRuntime } from "./claude-code";
import { createAgentRuntime } from "./factory";
import { OpenCodeRuntime } from "./opencode";

const cliAvailable: { isCommandAvailable: () => boolean } = {
	isCommandAvailable: () => true,
};

describe("createAgentRuntime", () => {
	it("constructs the claude-code runtime scaffold", () => {
		const runtime = createAgentRuntime(
			{
				provider: "claude-code",
				providers: { claudeCode: { model: "sonnet" } },
			},
			cliAvailable,
		);

		expect(runtime).toBeInstanceOf(ClaudeCodeRuntime);
		expect(runtime.provider).toBe("claude-code");
		expect((runtime as ClaudeCodeRuntime).config).toEqual({ model: "sonnet" });
	});

	it("preserves a configured Claude command alias without changing the default contract", () => {
		const runtime = createAgentRuntime(
			{
				provider: "claude-code",
				providers: { claudeCode: { command: "klaude" } },
			},
			cliAvailable,
		);

		expect(runtime).toBeInstanceOf(ClaudeCodeRuntime);
		expect((runtime as ClaudeCodeRuntime).config).toEqual({ command: "klaude" });
	});

	it("uses empty provider config when none is supplied", () => {
		const runtime = createAgentRuntime({ provider: "claude-code" }, cliAvailable);

		expect(runtime).toBeInstanceOf(ClaudeCodeRuntime);
		expect((runtime as ClaudeCodeRuntime).config).toEqual({});
	});

	it("constructs the opencode runtime scaffold", () => {
		const runtime = createAgentRuntime(
			{
				provider: "opencode",
				providers: { opencode: { model: "ollama/qwen2.5-coder:32b" } },
			},
			cliAvailable,
		);

		expect(runtime).toBeInstanceOf(OpenCodeRuntime);
		expect(runtime.provider).toBe("opencode");
		expect((runtime as OpenCodeRuntime).config).toEqual({ model: "ollama/qwen2.5-coder:32b" });
	});

	it("uses empty opencode provider config when none is supplied", () => {
		const runtime = createAgentRuntime({ provider: "opencode" }, cliAvailable);

		expect(runtime).toBeInstanceOf(OpenCodeRuntime);
		expect((runtime as OpenCodeRuntime).config).toEqual({});
	});

	it("rejects unknown providers", () => {
		expect(() =>
			createAgentRuntime({ provider: "unsupported" as unknown as "claude-code" }, cliAvailable),
		).toThrow(RuntimeError);
		expect(() =>
			createAgentRuntime({ provider: "unsupported" as unknown as "claude-code" }, cliAvailable),
		).toThrow("is not supported");
	});
});

describe("CLI validation", () => {
	it("throws when the claude-code CLI is not found on PATH", () => {
		expect(() =>
			createAgentRuntime({ provider: "claude-code" }, { isCommandAvailable: () => false }),
		).toThrow(RuntimeError);
	});

	it("error message names the missing command and suggests opencode as fallback", () => {
		expect(() =>
			createAgentRuntime({ provider: "claude-code" }, { isCommandAvailable: () => false }),
		).toThrow("'claude'");

		expect(() =>
			createAgentRuntime({ provider: "claude-code" }, { isCommandAvailable: () => false }),
		).toThrow("opencode");
	});

	it("throws when the opencode CLI is not found on PATH", () => {
		expect(() =>
			createAgentRuntime({ provider: "opencode" }, { isCommandAvailable: () => false }),
		).toThrow(RuntimeError);
	});

	it("error message names the missing command and suggests claude-code as fallback", () => {
		expect(() =>
			createAgentRuntime({ provider: "opencode" }, { isCommandAvailable: () => false }),
		).toThrow("'opencode'");

		expect(() =>
			createAgentRuntime({ provider: "opencode" }, { isCommandAvailable: () => false }),
		).toThrow("claude-code");
	});

	it("checks the configured command alias instead of the default", () => {
		const checkedCommands: string[] = [];
		createAgentRuntime(
			{
				provider: "claude-code",
				providers: { claudeCode: { command: "klaude" } },
			},
			{
				isCommandAvailable: (cmd) => {
					checkedCommands.push(cmd);
					return true;
				},
			},
		);

		expect(checkedCommands).toContain("klaude");
	});

	it("constructs the runtime successfully when CLI is found", () => {
		const runtime = createAgentRuntime(
			{ provider: "claude-code" },
			{ isCommandAvailable: () => true },
		);

		expect(runtime).toBeInstanceOf(ClaudeCodeRuntime);
	});
});
