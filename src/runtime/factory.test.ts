import { describe, expect, it } from "vitest";
import { RuntimeError } from "../utils/errors";
import { ClaudeCodeRuntime } from "./claude-code";
import { createAgentRuntime } from "./factory";
import { OpenCodeRuntime } from "./opencode";

describe("createAgentRuntime", () => {
	it("constructs the claude-code runtime scaffold", () => {
		const runtime = createAgentRuntime({
			provider: "claude-code",
			providers: { claudeCode: { model: "sonnet" } },
		});

		expect(runtime).toBeInstanceOf(ClaudeCodeRuntime);
		expect(runtime.provider).toBe("claude-code");
		expect((runtime as ClaudeCodeRuntime).config).toEqual({ model: "sonnet" });
	});

	it("preserves a configured Claude command alias without changing the default contract", () => {
		const runtime = createAgentRuntime({
			provider: "claude-code",
			providers: { claudeCode: { command: "klaude" } },
		});

		expect(runtime).toBeInstanceOf(ClaudeCodeRuntime);
		expect((runtime as ClaudeCodeRuntime).config).toEqual({ command: "klaude" });
	});

	it("uses empty provider config when none is supplied", () => {
		const runtime = createAgentRuntime({ provider: "claude-code" });

		expect(runtime).toBeInstanceOf(ClaudeCodeRuntime);
		expect((runtime as ClaudeCodeRuntime).config).toEqual({});
	});

	it("constructs the opencode runtime scaffold", () => {
		const runtime = createAgentRuntime({
			provider: "opencode",
			providers: { opencode: { model: "ollama/qwen2.5-coder:32b" } },
		});

		expect(runtime).toBeInstanceOf(OpenCodeRuntime);
		expect(runtime.provider).toBe("opencode");
		expect((runtime as OpenCodeRuntime).config).toEqual({ model: "ollama/qwen2.5-coder:32b" });
	});

	it("uses empty opencode provider config when none is supplied", () => {
		const runtime = createAgentRuntime({ provider: "opencode" });

		expect(runtime).toBeInstanceOf(OpenCodeRuntime);
		expect((runtime as OpenCodeRuntime).config).toEqual({});
	});

	it("rejects unknown providers", () => {
		expect(() =>
			createAgentRuntime({ provider: "unsupported" as unknown as "claude-code" }),
		).toThrow(RuntimeError);
		expect(() =>
			createAgentRuntime({ provider: "unsupported" as unknown as "claude-code" }),
		).toThrow("is not supported");
	});
});
