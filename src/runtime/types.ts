import type { Provider } from "@/config/types";

// --- Progress events (discriminated union) ---

export type ProgressEvent =
	| { type: "agent_start" }
	| { type: "tool_start"; tool: string }
	| { type: "tool_end"; tool: string }
	| { type: "text_output"; text: string }
	| { type: "cost_update"; totalCostUsd: number }
	| { type: "turn_complete"; turnNumber: number }
	| { type: "error"; message: string };

// --- Run options ---

export interface AgentRunOptions {
	/** The task or instruction for the agent to execute. */
	prompt: string;
	/** Optional system-level instruction prepended to the conversation. */
	systemPrompt?: string;
	/** Working directory for the agent (typically an isolated worktree). */
	cwd: string;
	/** File paths to include as context for the agent. */
	contextFiles?: string[];
	/** Maximum number of agentic turns before forcing a stop. */
	maxTurns?: number;
	/** Tool names or permission rules that may run without approval when supported by the runtime. */
	allowedTools?: string[];
	/** Callback invoked as the agent streams progress events. */
	onProgress?: (event: ProgressEvent) => void;
}

// --- Interactive options ---

export interface AgentInteractiveOptions {
	/** Initial prompt to start the interactive session. */
	prompt?: string;
	/** Optional system-level instruction for the session. */
	systemPrompt?: string;
	/** Working directory for the interactive session. */
	cwd: string;
	/** File paths to include as context for the session. */
	contextFiles?: string[];
}

// --- Run result ---

export interface AgentRunResult {
	/** Whether the agent run completed successfully. */
	success: boolean;
	/** The agent's final output or summary text. */
	output: string;
	/** Provider-assigned session identifier (maps to agentSessionId in state records). */
	sessionId: string;
	/** Total cost of the run in USD. */
	costUsd: number;
	/** Total wall-clock duration of the run in milliseconds. */
	durationMs: number;
	/** Error message when success is false. */
	error?: string;
}

// --- Core runtime interface ---

export interface AgentRuntime {
	/** Which provider this runtime wraps. */
	readonly provider: Provider;

	/** Run an autonomous agent session (e.g. implement a slice, generate a plan). */
	run(options: AgentRunOptions): Promise<AgentRunResult>;

	/** Hand off the terminal for an interactive agent session (e.g. RFC drafting). */
	runInteractive(options: AgentInteractiveOptions): Promise<AgentRunResult>;
}
