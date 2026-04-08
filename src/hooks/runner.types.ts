import type { spawn } from "node:child_process";
import type { HookEvent, HookInput, HookOutput, ResolvedHookDefinition } from "./types";

/**
 * Result of a single executed hook command after process + protocol handling.
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
	spawnImpl: typeof spawn;
}
