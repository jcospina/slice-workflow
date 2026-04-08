import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHookRunner } from "./runner";
import type { HookInput, ResolvedHookDefinition } from "./types";

const FIXED_TIMESTAMP = "2026-04-08T12:00:00.000Z";

describe("HookRunner", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("routes only hooks that match event and matcher", async () => {
		const script = await createScript(tempDirs, "echo-empty-output.js", [
			"process.stdin.resume();",
			"process.stdin.on('end', () => {",
			"  process.stdout.write('{}');",
			"});",
		]);

		const hooks: ResolvedHookDefinition[] = [
			makeHook(nodeCommand(script), "workflow:complete", '"sliceIndex":1'),
			makeHook(nodeCommand(script), "workflow:complete", '"sliceIndex":2'),
			makeHook(nodeCommand(script), "phase:start"),
		];

		const runner = createHookRunner({ hooks, cwd: process.cwd() });
		const result = await runner.run(
			makeInput({
				event: "workflow:complete",
				payload: { sliceIndex: 1 },
			}),
		);

		expect(result.matchedHooks).toBe(1);
		expect(result.executions).toHaveLength(1);
		expect(result.executions[0]?.success).toBe(true);
	});

	it("parses structured stdout JSON and aggregates continue=false", async () => {
		const script = await createScript(tempDirs, "output-stop.js", [
			"let body = '';",
			"process.stdin.on('data', (chunk) => { body += chunk; });",
			"process.stdin.on('end', () => {",
			"  const input = JSON.parse(body);",
			"  process.stdout.write(JSON.stringify({ continue: false, reason: `stop:${input.event}` }));",
			"});",
		]);

		const runner = createHookRunner({
			hooks: [makeHook(nodeCommand(script), "workflow:failed")],
			cwd: process.cwd(),
		});
		const result = await runner.run(makeInput({ event: "workflow:failed" }));

		expect(result.continue).toBe(false);
		expect(result.reason).toBe("stop:workflow:failed");
		expect(result.executions[0]?.success).toBe(true);
		expect(result.executions[0]?.output).toEqual({
			continue: false,
			reason: "stop:workflow:failed",
		});
	});

	it("treats malformed stdout as a non-blocking execution failure", async () => {
		const script = await createScript(tempDirs, "output-malformed.js", [
			"process.stdout.write('not-json');",
		]);

		const runner = createHookRunner({
			hooks: [makeHook(nodeCommand(script), "workflow:start")],
			cwd: process.cwd(),
		});
		const result = await runner.run(makeInput({ event: "workflow:start" }));

		expect(result.continue).toBe(true);
		expect(result.executions[0]?.success).toBe(false);
		expect(result.executions[0]?.error).toContain("malformed JSON");
	});

	it("enforces timeout and kills long-running hook commands", async () => {
		const script = await createScript(tempDirs, "never-exits.js", [
			"setInterval(() => {}, 1_000);",
		]);

		const runner = createHookRunner({
			hooks: [makeHook(nodeCommand(script), "phase:failed", undefined, 40)],
			cwd: process.cwd(),
		});
		const result = await runner.run(makeInput({ event: "phase:failed" }));

		expect(result.continue).toBe(true);
		expect(result.executions[0]?.success).toBe(false);
		expect(result.executions[0]?.timedOut).toBe(true);
		expect(result.executions[0]?.error).toContain("timed out");
	});

	it("treats non-zero exit codes as non-blocking failures", async () => {
		const script = await createScript(tempDirs, "exit-non-zero.js", [
			"process.stderr.write('boom');",
			"process.exit(3);",
		]);

		const runner = createHookRunner({
			hooks: [makeHook(nodeCommand(script), "slice:failed")],
			cwd: process.cwd(),
		});
		const result = await runner.run(makeInput({ event: "slice:failed" }));

		expect(result.continue).toBe(true);
		expect(result.executions[0]?.success).toBe(false);
		expect(result.executions[0]?.exitCode).toBe(3);
		expect(result.executions[0]?.error).toContain("code 3");
	});
});

function makeHook(
	command: string,
	event: ResolvedHookDefinition["events"][number],
	matcher?: string,
	timeoutMs = 5_000,
): ResolvedHookDefinition {
	return {
		command,
		events: [event],
		matcher,
		timeoutMs,
	};
}

function makeInput(overrides: Partial<HookInput> = {}): HookInput {
	return {
		event: "workflow:start",
		timestamp: FIXED_TIMESTAMP,
		runId: "run-123",
		payload: {},
		...overrides,
	};
}

function nodeCommand(scriptPath: string): string {
	return `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;
}

async function createScript(
	tempDirs: string[],
	fileName: string,
	lines: string[],
): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "slice-hooks-runner-"));
	tempDirs.push(dir);
	const scriptPath = join(dir, fileName);
	await writeFile(scriptPath, lines.join("\n"), "utf8");
	return scriptPath;
}
