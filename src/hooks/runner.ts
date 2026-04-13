import { spawn } from "node:child_process";
export {
	createAsyncHookRegistry,
	type AsyncHookEntry,
	type AsyncHookRegistry,
} from "./async-registry";
import type { AsyncHookRegistry } from "./async-registry";
import type { HookExecutionResult, HookRunResult, HookRunnerOptions } from "./runner.types";
import { executeHookCommand, matchesHook, parseHookStdout } from "./runner.utils";
import type { HookInput, ResolvedHookDefinition } from "./types";

export type {
	ExecuteHookCommandOptions,
	HookExecutionResult,
	HookRunResult,
	HookRunnerOptions,
	HookStdoutParseResult,
	SpawnHookExecutionResult,
} from "./runner.types";
export { matchesHook, parseHookStdout } from "./runner.utils";

/**
 * Executes lifecycle hooks for one emitted orchestration event.
 *
 * Hooks are evaluated in resolved config order and failures are represented in
 * the returned execution objects instead of throwing, so callers can treat hook
 * execution as best-effort by default.
 */
export class HookRunner {
	private readonly hooks: ResolvedHookDefinition[];
	private readonly cwd: string;
	private readonly spawnImpl: typeof spawn;
	private readonly now: () => number;
	private readonly registry: AsyncHookRegistry | undefined;

	/**
	 * @param options Runner dependencies and resolved hook definitions.
	 */
	constructor(options: HookRunnerOptions) {
		this.hooks = options.hooks;
		this.cwd = options.cwd ?? process.cwd();
		this.spawnImpl = options.spawnImpl ?? spawn;
		this.now = options.now ?? Date.now;
		this.registry = options.registry;
	}

	/**
	 * Resolves hooks that should run for the provided lifecycle input.
	 *
	 * @param input Lifecycle payload emitted by the orchestrator.
	 * @returns Matching hooks in deterministic config order.
	 */
	resolveMatchingHooks(input: HookInput): ResolvedHookDefinition[] {
		const serializedInput = JSON.stringify(input);
		return this.hooks.filter((hook) => matchesHook(hook, input, serializedInput));
	}

	/**
	 * Runs all matching hooks and aggregates their `continue` decisions.
	 *
	 * Blocking hooks (`async: false`, the default) are awaited in order and
	 * their `continue` output influences the aggregate result.
	 *
	 * Async hooks (`async: true`) are dispatched fire-and-forget into the
	 * `AsyncHookRegistry` (when one is configured) and always contribute
	 * `continue: true` to the aggregate.  If no registry was provided, async
	 * hooks fall back to blocking execution so no hooks are silently dropped.
	 *
	 * @param input Lifecycle payload emitted by the orchestrator.
	 * @returns Per-hook execution data plus aggregate continue/reason fields.
	 */
	async run(input: HookInput): Promise<HookRunResult> {
		const matchingHooks = this.resolveMatchingHooks(input);
		const executions: HookExecutionResult[] = [];
		let shouldContinue = true;
		let continueReason: string | null = null;

		for (const hook of matchingHooks) {
			if (hook.async && this.registry) {
				const execution = this.dispatchAsyncHook(hook, input);
				executions.push(execution);
				// Async hooks never block the continue decision.
			} else {
				const execution = await this.executeHook(hook, input);
				executions.push(execution);

				if (!execution.continue) {
					shouldContinue = false;
					if (!continueReason) {
						continueReason = execution.reason ?? `Hook requested stop: ${hook.command}`;
					}
				}
			}
		}

		return {
			event: input.event,
			input,
			matchedHooks: matchingHooks.length,
			executions,
			continue: shouldContinue,
			reason: continueReason,
		};
	}

	/**
	 * Dispatches a hook as fire-and-forget into the registry and returns a
	 * synthetic `pending` result immediately.
	 *
	 * @param hook Resolved async hook definition.
	 * @param input Lifecycle payload to send on stdin.
	 * @returns Synthetic execution result with `pending: true`.
	 */
	private dispatchAsyncHook(hook: ResolvedHookDefinition, input: HookInput): HookExecutionResult {
		const controller = new AbortController();
		const startedAt = this.now();
		const promise = this.executeHook(hook, input, controller.signal);

		this.registry?.register({
			command: hook.command,
			startedAt,
			promise,
			abort: () => controller.abort(),
		});

		return {
			hook,
			success: true,
			continue: true,
			reason: null,
			error: null,
			output: null,
			stdout: "",
			stderr: "",
			exitCode: null,
			signal: null,
			timedOut: false,
			durationMs: 0,
			pending: true,
		};
	}

	/**
	 * Executes one hook command and maps process/protocol outcomes to the stable
	 * `HookExecutionResult` contract.
	 *
	 * @param hook Resolved hook definition to execute.
	 * @param input Lifecycle payload to serialize and pipe to stdin.
	 * @param signal Optional abort signal for fire-and-forget (async) execution.
	 * @returns Normalized execution result for this hook.
	 */
	private async executeHook(
		hook: ResolvedHookDefinition,
		input: HookInput,
		signal?: AbortSignal,
	): Promise<HookExecutionResult> {
		const startedAt = this.now();
		const payload = JSON.stringify(input);
		const processResult = await executeHookCommand({
			command: hook.command,
			timeoutMs: hook.timeoutMs,
			payload,
			cwd: this.cwd,
			env: hook.env ? { ...process.env, ...hook.env } : process.env,
			spawnImpl: this.spawnImpl,
			signal,
		});
		const durationMs = Math.max(0, this.now() - startedAt);

		if (processResult.launchError) {
			return {
				hook,
				success: false,
				continue: true,
				reason: null,
				error: `Failed to start hook command: ${processResult.launchError.message}`,
				output: null,
				stdout: processResult.stdout,
				stderr: processResult.stderr,
				exitCode: processResult.exitCode,
				signal: processResult.signal,
				timedOut: processResult.timedOut,
				durationMs,
			};
		}

		if (processResult.timedOut) {
			return {
				hook,
				success: false,
				continue: true,
				reason: null,
				error: `Hook timed out after ${hook.timeoutMs}ms`,
				output: null,
				stdout: processResult.stdout,
				stderr: processResult.stderr,
				exitCode: processResult.exitCode,
				signal: processResult.signal,
				timedOut: true,
				durationMs,
			};
		}

		if (processResult.exitCode !== 0 || processResult.signal !== null) {
			const error =
				processResult.signal !== null
					? `Hook terminated by signal ${processResult.signal}`
					: `Hook exited with code ${processResult.exitCode ?? "unknown"}`;
			return {
				hook,
				success: false,
				continue: true,
				reason: null,
				error,
				output: null,
				stdout: processResult.stdout,
				stderr: processResult.stderr,
				exitCode: processResult.exitCode,
				signal: processResult.signal,
				timedOut: false,
				durationMs,
			};
		}

		const parsed = parseHookStdout(processResult.stdout);
		if (parsed.error) {
			return {
				hook,
				success: false,
				continue: true,
				reason: null,
				error: parsed.error,
				output: null,
				stdout: processResult.stdout,
				stderr: processResult.stderr,
				exitCode: processResult.exitCode,
				signal: processResult.signal,
				timedOut: false,
				durationMs,
			};
		}

		const output = parsed.output ?? {};
		return {
			hook,
			success: true,
			continue: output.continue !== false,
			reason: output.reason ?? null,
			error: null,
			output,
			stdout: processResult.stdout,
			stderr: processResult.stderr,
			exitCode: processResult.exitCode,
			signal: processResult.signal,
			timedOut: false,
			durationMs,
		};
	}
}

/**
 * Creates a `HookRunner` instance with the provided dependencies.
 *
 * @param options Runner dependencies and resolved hook definitions.
 * @returns Configured hook runner instance.
 */
export function createHookRunner(options: HookRunnerOptions): HookRunner {
	return new HookRunner(options);
}
