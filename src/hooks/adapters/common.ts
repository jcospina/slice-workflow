import { HOOK_EVENTS, type HookEvent, type HookInput } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export async function readHookInputFromStdin(adapterName: string): Promise<HookInput> {
	const chunks: Buffer[] = [];

	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error(`${adapterName}: failed to parse HookInput JSON from stdin`);
	}

	if (
		!isRecord(parsed) ||
		typeof parsed.event !== "string" ||
		typeof parsed.timestamp !== "string" ||
		!isRecord(parsed.payload)
	) {
		throw new Error(`${adapterName}: HookInput payload is invalid`);
	}
	if (!HOOK_EVENTS.includes(parsed.event as HookEvent)) {
		throw new Error(`${adapterName}: unknown hook event '${parsed.event}'`);
	}

	return {
		event: parsed.event as HookEvent,
		timestamp: parsed.timestamp,
		runId: typeof parsed.runId === "string" ? parsed.runId : undefined,
		payload: parsed.payload,
	};
}

export function toSafeString(value: unknown, fallback = "unknown"): string {
	if (typeof value === "string" && value.length > 0) {
		return value;
	}
	if (value === null || value === undefined) {
		return fallback;
	}
	return String(value);
}

export function toSafeNumber(value: unknown, fallback = 0): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}
