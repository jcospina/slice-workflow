import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config";
import { runPlanWithInputs } from "../../orchestrator/phases/plan";
import { createPromptBuilder } from "../../prompts";
import { createAgentRuntime } from "../../runtime";
import { registerPlanCommand } from "./plan";

vi.mock("../../config", () => ({
	loadConfig: vi.fn(),
}));

vi.mock("../../runtime", () => ({
	createAgentRuntime: vi.fn(),
}));

vi.mock("../../prompts", () => ({
	createPromptBuilder: vi.fn(),
}));

vi.mock("../../orchestrator/phases/plan", () => ({
	runPlanWithInputs: vi.fn(),
}));

describe("registerPlanCommand", () => {
	const loadConfigMock = vi.mocked(loadConfig);
	const createAgentRuntimeMock = vi.mocked(createAgentRuntime);
	const createPromptBuilderMock = vi.mocked(createPromptBuilder);
	const runPlanWithInputsMock = vi.mocked(runPlanWithInputs);
	let cwdSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/repo");
		process.exitCode = undefined;

		loadConfigMock.mockReturnValue({
			provider: "claude-code",
			providers: { claudeCode: {}, opencode: {} },
			messaging: {},
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
		runPlanWithInputsMock.mockResolvedValue({
			status: "completed",
			agentSessionId: "sess-1",
			costUsd: 0.5,
			durationMs: 200,
			error: null,
			output: "/repo/implementations/my-plan/my-plan.md",
		});
	});

	afterEach(() => {
		cwdSpy.mockRestore();
		vi.restoreAllMocks();
		vi.clearAllMocks();
		process.exitCode = undefined;
	});

	it("requires a prompt argument", async () => {
		const program = makeProgram();
		await expect(program.parseAsync(["node", "slice", "plan"], { from: "node" })).rejects.toThrow();
	});

	it("calls runPlanWithInputs with context built from prompt and no rfcPath when --rfc is omitted", async () => {
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {
			// noop in tests
		});
		const program = makeProgram();

		await program.parseAsync(["node", "slice", "plan", "add", "user", "auth"], { from: "node" });

		expect(runPlanWithInputsMock).toHaveBeenCalledTimes(1);
		expect(runPlanWithInputsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "plan",
				projectCwd: "/repo",
				implementationsDir: "/repo/implementations",
				run: expect.objectContaining({
					taskDescription: "add user auth",
					currentPhase: "plan",
					status: "running",
				}),
			}),
			{ rfcPath: undefined },
		);
		expect(infoSpy).toHaveBeenCalledWith("Plan saved to /repo/implementations/my-plan/my-plan.md");
	});

	it("resolves --rfc path relative to cwd and passes it as rfcPath", async () => {
		vi.spyOn(console, "info").mockImplementation(() => {
			// noop in tests
		});
		const program = makeProgram();

		await program.parseAsync(["node", "slice", "plan", "my task", "--rfc", "docs/rfc.md"], {
			from: "node",
		});

		expect(runPlanWithInputsMock).toHaveBeenCalledWith(expect.anything(), {
			rfcPath: "/repo/docs/rfc.md",
		});
	});

	it("sets exitCode and prints error when phase fails", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
			// noop in tests
		});
		runPlanWithInputsMock.mockResolvedValueOnce({
			status: "failed",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			error: "Plan artifact was not created.",
			output: null,
		});

		const program = makeProgram();
		await program.parseAsync(["node", "slice", "plan", "some", "task"], { from: "node" });

		expect(process.exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("Plan artifact was not created.");
	});

	it("sets exitCode when phase returns completed but output is missing", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
			// noop in tests
		});
		runPlanWithInputsMock.mockResolvedValueOnce({
			status: "completed",
			agentSessionId: "sess-1",
			costUsd: 0,
			durationMs: 0,
			error: null,
			output: null,
		});

		const program = makeProgram();
		await program.parseAsync(["node", "slice", "plan", "some", "task"], { from: "node" });

		expect(process.exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("Plan phase failed.");
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
	registerPlanCommand(program);
	return program;
}
