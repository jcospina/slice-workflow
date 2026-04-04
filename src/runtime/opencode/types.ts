import type { ResolvedConfig } from "@/config/types";
import type { OpenCodeServeManager } from "./serve-manager";

export type OpenCodeRuntimeConfig = ResolvedConfig["providers"]["opencode"];

export interface OpenCodeRuntimeDependencies {
	serveManager?: OpenCodeServeManager;
	createClient?: (cwd: string) => OpenCodeSessionClient;
	runOpenCodeCli?: (invocation: OpenCodeCliInvocation) => Promise<OpenCodeCliProcessResult>;
	now?: () => number;
	createSessionId?: () => string;
}

export interface OpenCodeModel {
	providerId: string;
	modelId: string;
}

export interface OpenCodeSession {
	id: string;
}

export interface OpenCodeAssistantError {
	name?: string;
	data?: {
		message?: string;
	};
}

export interface OpenCodePromptPart {
	type: string;
	text?: string;
}

export interface OpenCodePromptMessage {
	info: {
		sessionId?: string;
		cost?: number;
		error?: OpenCodeAssistantError;
	};
	parts: OpenCodePromptPart[];
}

export interface OpenCodeApiResult<T> {
	data?: T;
	error?: unknown;
}

export interface OpenCodePermissionEvent {
	type?: string;
	properties?: {
		sessionId?: string;
		id?: string;
	};
}

export interface OpenCodeSessionClient {
	session: {
		create(options: {
			query: { directory: string };
			body?: { title?: string };
		}): Promise<OpenCodeApiResult<OpenCodeSession>>;
		prompt(options: {
			path: { id: string };
			query: { directory: string };
			body: {
				parts: [{ type: "text"; text: string }];
				system?: string;
				model?: OpenCodeModel;
				tools?: Record<string, boolean>;
			};
		}): Promise<OpenCodeApiResult<OpenCodePromptMessage>>;
	};
	event: {
		subscribe(options: {
			query: { directory: string };
			signal: AbortSignal;
		}): Promise<{ stream: AsyncIterable<OpenCodePermissionEvent> }>;
	};
	postSessionIdPermissionsPermissionId(options: {
		path: { id: string; permissionId: string };
		query: { directory: string };
		body: { response: "once" | "always" | "reject" };
	}): Promise<OpenCodeApiResult<boolean>>;
}

export interface OpenCodeCliInvocation {
	command: string;
	args: string[];
	cwd: string;
	method: "runInteractive";
	stdio?: "inherit" | "pipe";
}

export interface OpenCodeCliProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}
