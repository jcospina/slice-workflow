import type { spawn } from "node:child_process";
import type { AsyncHookRegistry } from "./async-registry";
import type { HookEvent, HookInput, HookOutput, ResolvedHookDefinition } from "./types";

/**
 * Result of a single executed hook command after process + protocol handling.
 *
 * When `pending` is `true` the hook was dispatched fire-and-forget (async
 * mode).  In that case `success`, `exitCode`, `signal`, `stdout`, `stderr`,
 * and `durationMs` are synthetic placeholders — the real outcome is tracked
 * in the `AsyncHookRegistry`.
 */
export interface HookExecutionResult {
	hook: ResolvedHookDefinition;
	success: boolean;
	continue: boolean;
	reason: string | null;
	error: string | null;
	output: HookOutput | null;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	durationMs: number;
	/**
	 * `true` when the hook was dispatched asynchronously (fire-and-forget).
	 * The result fields above are placeholders; the actual outcome is tracked
	 * in the `AsyncHookRegistry` passed to the runner.
	 */
	pending?: boolean;
}

/**
 * Aggregate hook-run outcome for one emitted lifecycle event.
 */
export interface HookRunResult {
	event: HookEvent;
	input: HookInput;
	matchedHooks: number;
	executions: HookExecutionResult[];
	continue: boolean;
	reason: string | null;
}

/**
 * Dependency and configuration inputs used to construct `HookRunner`.
 */
export interface HookRunnerOptions {
	hooks: ResolvedHookDefinition[];
	cwd?: string;
	spawnImpl?: typeof spawn;
	now?: () => number;
	/**
	 * Registry for tracking fire-and-forget (async) hook executions.
	 * When omitted, hooks marked `async: true` fall back to blocking execution
	 * so no hooks are silently dropped.
	 */
	registry?: AsyncHookRegistry;
}

/**
 * Raw child-process outcome prior to stdout protocol parsing.
 */
export interface SpawnHookExecutionResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	launchError: Error | null;
}

/**
 * Output of parsing hook stdout as `HookOutput` JSON.
 */
export interface HookStdoutParseResult {
	output: HookOutput | null;
	error: string | null;
}

/**
 * Input contract for low-level hook command execution helper.
 */
export interface ExecuteHookCommandOptions {
	command: string;
	timeoutMs: number;
	payload: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	spawnImpl: typeof spawn;
	/**
	 * Optional abort signal.  When the signal fires the hook process receives
	 * SIGTERM followed by SIGKILL after the force-kill grace period.
	 * If the signal is already aborted on entry the promise resolves
	 * immediately with a launchError.
	 */
	signal?: AbortSignal;
}
