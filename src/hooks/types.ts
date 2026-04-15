export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;
export const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

export const HOOK_EVENTS = [
	"workflow:start",
	"workflow:complete",
	"workflow:failed",
	"phase:start",
	"phase:complete",
	"phase:failed",
	"slice:start",
	"slice:complete",
	"slice:failed",
	"slice:approval_requested",
	"slice:approval_received",
	"review:start",
	"review:verdict",
	"approval:requested",
	"approval:received",
] as const;

export const HOOK_ADAPTERS = ["slack", "telegram"] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];
export type HookAdapter = (typeof HOOK_ADAPTERS)[number];

export interface HookInput {
	event: HookEvent;
	timestamp: string;
	runId?: string;
	payload: Record<string, unknown>;
}

export interface HookOutput {
	continue?: boolean;
	reason?: string;
}

export interface HookDefinition {
	command?: string;
	adapter?: HookAdapter;
	events: HookEvent[];
	matcher?: string;
	timeoutMs?: number;
	envFrom?: Record<string, string>;
	/**
	 * When `true`, the hook is dispatched as fire-and-forget: the orchestrator
	 * does not await its completion and it cannot influence the `continue`
	 * decision.  Pending async hooks are tracked in `AsyncHookRegistry` so
	 * they can be drained or cancelled on shutdown.
	 *
	 * When `false` (default), the hook blocks the orchestrator until it
	 * settles and its `continue` output is respected.
	 */
	async?: boolean;
}

export interface ResolvedHookDefinition extends HookDefinition {
	command: string;
	timeoutMs: number;
	async: boolean;
	env?: Record<string, string>;
}
