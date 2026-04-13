import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HookAdapter } from "../types";

const ADAPTER_SCRIPT_NAME: Record<HookAdapter, string> = {
	slack: "notify-slack.js",
	telegram: "notify-telegram.js",
};

export function getBundledHookAdapterScriptPath(adapter: HookAdapter): string {
	const scriptName = ADAPTER_SCRIPT_NAME[adapter];
	const startDirs = new Set<string>([
		dirname(fileURLToPath(import.meta.url)),
		process.argv[1] ? dirname(resolve(process.argv[1])) : "",
		process.cwd(),
	]);
	const searched = new Set<string>();

	for (const startDir of startDirs) {
		if (!startDir) {
			continue;
		}
		for (const dir of walkUpDirectories(startDir)) {
			const candidates = [
				resolve(dir, "hooks", "adapters", scriptName),
				resolve(dir, "dist", "hooks", "adapters", scriptName),
			];
			for (const candidate of candidates) {
				searched.add(candidate);
				if (existsSync(candidate)) {
					return candidate;
				}
			}
		}
	}

	throw new Error(
		[
			`Unable to locate bundled hook adapter script '${scriptName}'.`,
			"Searched paths:",
			...Array.from(searched).map((path) => `- ${path}`),
		].join("\n"),
	);
}

export function createBundledHookAdapterCommand(adapter: HookAdapter): string {
	const nodePath = JSON.stringify(process.execPath);
	const scriptPath = JSON.stringify(getBundledHookAdapterScriptPath(adapter));
	return `${nodePath} ${scriptPath}`;
}

function* walkUpDirectories(startPath: string): Generator<string> {
	let current = resolve(startPath);
	while (true) {
		yield current;
		const parent = dirname(current);
		if (parent === current) {
			return;
		}
		current = parent;
	}
}
