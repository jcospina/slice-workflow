import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBundledHookAdapterCommand } from "../../hooks/adapters/path";
import { createHookRunner } from "../../hooks/runner";
import {
	parseEnvFile,
	parseEnvValue,
	registerSmokeSlackCommand,
	registerSmokeTelegramCommand,
} from "./smoke";

vi.mock("../../hooks/adapters/path", () => ({
	createBundledHookAdapterCommand: vi.fn((adapter: string) => `cmd-${adapter}`),
}));

vi.mock("../../hooks/runner", () => ({
	createHookRunner: vi.fn(),
}));

interface MockRunner {
	run: ReturnType<typeof vi.fn>;
}

describe("smoke commands", () => {
	let cwdSpy: ReturnType<typeof vi.spyOn>;
	let tempDir: string;
	let mockRunner: MockRunner;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "slice-smoke-test-"));
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
		mockRunner = {
			run: vi.fn().mockResolvedValue({
				executions: [{ success: true, error: null }],
			}),
		};
		vi.mocked(createHookRunner).mockReturnValue(mockRunner as never);
	});

	afterEach(() => {
		cwdSpy.mockRestore();
		rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it("smoke-slack reads token from env file and injects input channel", async () => {
		writeFileSync(join(tempDir, ".env"), "SLACK_BOT_TOKEN=xoxb-smoke\n", "utf8");
		const program = new Command();
		registerSmokeSlackCommand(program);

		await program.parseAsync(["node", "slice", "smoke-slack", "--channel", "C12345"], {
			from: "node",
		});

		expect(createBundledHookAdapterCommand).toHaveBeenCalledWith("slack");
		expect(createHookRunner).toHaveBeenCalledWith(
			expect.objectContaining({
				hooks: [
					expect.objectContaining({
						adapter: "slack",
						env: Object.fromEntries([
							["SLACK_BOT_TOKEN", "xoxb-smoke"],
							["SLACK_CHANNEL", "C12345"],
						]),
					}),
				],
			}),
		);
		expect(mockRunner.run).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "workflow:start",
				payload: expect.objectContaining({ slug: "smoke-slack" }),
			}),
		);
	});

	it("smoke-telegram reads token from env file and injects input chat id", async () => {
		writeFileSync(join(tempDir, ".custom.env"), "TELEGRAM_BOT_TOKEN=123:abc\n", "utf8");
		const program = new Command();
		registerSmokeTelegramCommand(program);

		await program.parseAsync(
			["node", "slice", "smoke-telegram", "--chat-id", "-100999", "--env-file", ".custom.env"],
			{ from: "node" },
		);

		expect(createBundledHookAdapterCommand).toHaveBeenCalledWith("telegram");
		expect(createHookRunner).toHaveBeenCalledWith(
			expect.objectContaining({
				hooks: [
					expect.objectContaining({
						adapter: "telegram",
						env: Object.fromEntries([
							["TELEGRAM_BOT_TOKEN", "123:abc"],
							["TELEGRAM_CHAT_ID", "-100999"],
						]),
					}),
				],
			}),
		);
	});

	it("surfaces hook failure details for smoke-slack", async () => {
		writeFileSync(join(tempDir, ".env"), "SLACK_BOT_TOKEN=xoxb-smoke\n", "utf8");
		mockRunner.run.mockResolvedValueOnce({
			executions: [
				{
					success: false,
					error: "Hook exited with code 1",
					hook: { command: "node dist/hooks/adapters/notify-slack.js" },
					exitCode: 1,
					stderr: "notify-slack: Slack API error: invalid_auth\n",
					stdout: "",
				},
			],
		});
		const program = new Command();
		registerSmokeSlackCommand(program);

		await expect(
			program.parseAsync(["node", "slice", "smoke-slack", "--channel", "C12345"], {
				from: "node",
			}),
		).rejects.toThrow(
			[
				"Smoke hook failed",
				"command: node dist/hooks/adapters/notify-slack.js",
				"error: Hook exited with code 1",
				"exitCode: 1",
				"stderr: notify-slack: Slack API error: invalid_auth",
			].join("\n"),
		);
	});
});

describe("smoke env parsing", () => {
	it("parseEnvFile handles export prefix and comments", () => {
		const parsed = parseEnvFile("export TOKEN=abc\nFOO=bar #comment\n#ignore\n");
		expect(parsed).toEqual(
			Object.fromEntries([
				["TOKEN", "abc"],
				["FOO", "bar"],
			]),
		);
	});

	it("parseEnvValue handles quoted values", () => {
		expect(parseEnvValue('"line1\\nline2"')).toBe("line1\nline2");
		expect(parseEnvValue("'quoted'")).toBe("quoted");
	});
});
