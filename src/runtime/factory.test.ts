import { describe, expect, it } from "vitest";
import { RuntimeError } from "../utils/errors";
import { ClaudeCodeRuntime } from "./claude-code";
import { createAgentRuntime } from "./factory";

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

	it("rejects providers without runtime wiring", () => {
		expect(() => createAgentRuntime({ provider: "opencode" })).toThrow(RuntimeError);
		expect(() => createAgentRuntime({ provider: "opencode" })).toThrow(
			"does not have a runtime implementation yet",
		);
	});
});
