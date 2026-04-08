import type {
	ExecuteHookCommandOptions,
	HookStdoutParseResult,
	SpawnHookExecutionResult,
} from "./runner.types";
import type { HookInput, HookOutput, ResolvedHookDefinition } from "./types";

const FORCE_KILL_AFTER_TIMEOUT_MS = 250;

/**
 * Evaluates whether a hook matches an emitted lifecycle input.
 *
 * Matching rules:
 * 1. `input.event` must be listed in `hook.events`.
 * 2. If `hook.matcher` exists, it is executed as RegExp against the serialized
 *    hook input JSON string.
 *
 * @param hook Candidate hook definition.
 * @param input Lifecycle input payload.
 * @param serializedInput Optional precomputed JSON payload for matcher checks.
 * @returns `true` when the hook should run for this input.
 */
export function matchesHook(
	hook: ResolvedHookDefinition,
	input: HookInput,
	serializedInput: string = JSON.stringify(input),
): boolean {
	if (!hook.events.includes(input.event)) {
		return false;
	}
	if (!hook.matcher) {
		return true;
	}
	try {
		return new RegExp(hook.matcher).test(serializedInput);
	} catch {
		return false;
	}
}

/**
 * Parses hook command stdout into the `HookOutput` protocol.
 *
 * Empty stdout is interpreted as `{}` to allow hooks that only care about side
 * effects and do not emit structured output.
 *
 * @param stdout Raw stdout content from the hook command.
 * @returns Parsed output object or a protocol error message.
 */
export function parseHookStdout(stdout: string): HookStdoutParseResult {
	const trimmed = stdout.trim();
	if (trimmed.length === 0) {
		return { output: {}, error: null };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { output: null, error: "Hook emitted malformed JSON on stdout" };
	}

	if (!isRecord(parsed)) {
		return { output: null, error: "Hook stdout JSON must be an object" };
	}

	const output: HookOutput = {};

	if ("continue" in parsed) {
		if (typeof parsed.continue !== "boolean") {
			return { output: null, error: "Hook output field 'continue' must be a boolean" };
		}
		output.continue = parsed.continue;
	}

	if ("reason" in parsed) {
		if (typeof parsed.reason !== "string") {
			return { output: null, error: "Hook output field 'reason' must be a string" };
		}
		output.reason = parsed.reason;
	}

	return { output, error: null };
}

/**
 * Executes a hook command by piping the lifecycle payload on stdin.
 *
 * Timeout policy:
 * 1. Send `SIGTERM` when `timeoutMs` is exceeded.
 * 2. Send `SIGKILL` after a short grace period if the process is still alive.
 *
 * @param options Process invocation options and dependencies.
 * @returns Raw process outcome with stdout/stderr, exit metadata, and timeout state.
 */
export function executeHookCommand(
	options: ExecuteHookCommandOptions,
): Promise<SpawnHookExecutionResult> {
	return new Promise((resolve) => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		let settled = false;
		let timedOut = false;
		const timers: {
			timeoutHandle?: ReturnType<typeof setTimeout>;
			forceKillHandle?: ReturnType<typeof setTimeout>;
		} = {};

		const finish = (result: SpawnHookExecutionResult) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timers.timeoutHandle) {
				clearTimeout(timers.timeoutHandle);
			}
			if (timers.forceKillHandle) {
				clearTimeout(timers.forceKillHandle);
			}
			resolve(result);
		};

		let child: ReturnType<ExecuteHookCommandOptions["spawnImpl"]>;

		try {
			child = options.spawnImpl(options.command, {
				cwd: options.cwd,
				shell: true,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			finish({
				stdout: "",
				stderr: "",
				exitCode: null,
				signal: null,
				timedOut: false,
				launchError: normalizeError(error),
			});
			return;
		}

		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout.push(chunk.toString());
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr.push(chunk.toString());
		});

		child.once("error", (error) => {
			finish({
				stdout: stdout.join(""),
				stderr: stderr.join(""),
				exitCode: null,
				signal: null,
				timedOut,
				launchError: normalizeError(error),
			});
		});

		child.once("close", (exitCode, signal) => {
			finish({
				stdout: stdout.join(""),
				stderr: stderr.join(""),
				exitCode,
				signal,
				timedOut,
				launchError: null,
			});
		});

		timers.timeoutHandle = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			timers.forceKillHandle = setTimeout(() => {
				if (!child.killed) {
					child.kill("SIGKILL");
				}
			}, FORCE_KILL_AFTER_TIMEOUT_MS);
		}, options.timeoutMs);

		child.stdin?.on("error", () => {
			// Broken pipes are surfaced via close/exit; ignore write-side noise.
		});
		child.stdin?.end(`${options.payload}\n`);
	});
}

/**
 * Type guard for plain object checks during stdout protocol parsing.
 *
 * @param value Unknown parsed JSON value.
 * @returns `true` when `value` is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Normalizes unknown thrown values into an `Error` instance.
 *
 * @param error Unknown thrown value.
 * @returns Error object with message content preserved.
 */
function normalizeError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}
	return new Error(String(error));
}
