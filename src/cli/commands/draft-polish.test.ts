import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config";
import { runDraftPolishWithArtifacts } from "../../orchestrator/phases/draft-polish";
import { createPromptBuilder } from "../../prompts";
import { createAgentRuntime } from "../../runtime";
import { registerDraftPolishCommand } from "./draft-polish";

vi.mock("../../config", () => ({
	loadConfig: vi.fn(),
}));

vi.mock("../../runtime", () => ({
	createAgentRuntime: vi.fn(),
}));

vi.mock("../../prompts", () => ({
	createPromptBuilder: vi.fn(),
}));

vi.mock("../../orchestrator/phases/draft-polish", () => ({
	runDraftPolishWithArtifacts: vi.fn(),
}));

describe("registerDraftPolishCommand", () => {
	const loadConfigMock = vi.mocked(loadConfig);
	const createAgentRuntimeMock = vi.mocked(createAgentRuntime);
	const createPromptBuilderMock = vi.mocked(createPromptBuilder);
	const runDraftPolishWithArtifactsMock = vi.mocked(runDraftPolishWithArtifacts);
	let cwdSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/repo");
		process.exitCode = undefined;

		loadConfigMock.mockReturnValue({
			provider: "claude-code",
			providers: { claudeCode: {}, opencode: {} },
			hooks: [],
			implementationsDir: "implementations",
			approvalGates: { rfc: false, plan: false },
			sliceExecution: "autonomous",
			review: {
				enabled: true,
				maxIterations: 2,
				severityThreshold: "major",
			},
		});
		createAgentRuntimeMock.mockReturnValue({
			provider: "claude-code",
			run: vi.fn(),
			runInteractive: vi.fn(),
		});
		createPromptBuilderMock.mockReturnValue({
			buildPrompt: vi.fn(),
			buildSystemPrompt: vi.fn(),
			buildTaskPrompt: vi.fn(),
		});
		runDraftPolishWithArtifactsMock.mockResolvedValue({
			status: "completed",
			agentSessionId: "sess-1",
			costUsd: 0.1,
			durationMs: 100,
			error: null,
			output: "/repo/docs/rfc.md",
		});
	});

	afterEach(() => {
		cwdSpy.mockRestore();
		vi.restoreAllMocks();
		vi.clearAllMocks();
		process.exitCode = undefined;
	});

	it("requires --input", async () => {
		const program = makeProgram();

		await expect(
			program.parseAsync(["node", "slice", "draft-polish"], { from: "node" }),
		).rejects.toThrow("--input");
	});

	it("uses default output path when --output is omitted", async () => {
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {
			// noop in tests
		});
		const program = makeProgram();

		await program.parseAsync(["node", "slice", "draft-polish", "--input", "docs/rfc-draft.md"], {
			from: "node",
		});

		expect(runDraftPolishWithArtifactsMock).toHaveBeenCalledTimes(1);
		expect(runDraftPolishWithArtifactsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "draft-polish",
			}),
			{
				inputPath: "/repo/docs/rfc-draft.md",
				outputPath: "/repo/docs/rfc.md",
			},
		);
		expect(infoSpy).toHaveBeenCalledWith("Polished RFC saved to /repo/docs/rfc.md");
	});

	it("forwards explicit --output path", async () => {
		const program = makeProgram();

		await program.parseAsync(
			[
				"node",
				"slice",
				"draft-polish",
				"--input",
				"docs/rfc-draft.md",
				"--output",
				"artifacts/final-rfc.md",
			],
			{ from: "node" },
		);

		expect(runDraftPolishWithArtifactsMock).toHaveBeenCalledWith(expect.anything(), {
			inputPath: "/repo/docs/rfc-draft.md",
			outputPath: "/repo/artifacts/final-rfc.md",
		});
	});

	it("sets exitCode and prints error when phase fails", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
			// noop in tests
		});
		runDraftPolishWithArtifactsMock.mockResolvedValueOnce({
			status: "failed",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			error: "polish failed",
			output: null,
		});

		const program = makeProgram();
		await program.parseAsync(["node", "slice", "draft-polish", "--input", "docs/rfc-draft.md"], {
			from: "node",
		});

		expect(process.exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("polish failed");
	});
});

function makeProgram(): Command {
	const program = new Command();
	program.name("slice");
	program.exitOverride();
	program.configureOutput({
		writeOut: () => {
			// noop in tests
		},
		writeErr: () => {
			// noop in tests
		},
	});
	registerDraftPolishCommand(program);
	return program;
}
