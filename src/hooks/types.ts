export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

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
	"review:start",
	"review:verdict",
	"approval:requested",
	"approval:received",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

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
	command: string;
	events: HookEvent[];
	matcher?: string;
	timeoutMs?: number;
}

export interface ResolvedHookDefinition extends HookDefinition {
	timeoutMs: number;
}
