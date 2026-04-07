import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_EXAMPLES = ["decouple-data-layer", "income-tracking"] as const;

export function getBundledExamplesPath(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const searchedPaths = new Set<string>();

	for (const baseDir of walkUpDirectories(moduleDir)) {
		const candidates = [
			resolve(baseDir, "examples"),
			resolve(baseDir, "dist", "examples"),
			resolve(baseDir, "implementations"),
		];

		for (const candidate of candidates) {
			if (searchedPaths.has(candidate)) {
				continue;
			}
			searchedPaths.add(candidate);

			if (hasAllRequiredExamples(candidate)) {
				return candidate;
			}
		}
	}

	throw new Error(
		[
			"Unable to locate bundled examples directory containing required examples.",
			"Searched paths:",
			...Array.from(searchedPaths).map((path) => `- ${path}`),
		].join("\n"),
	);
}

function hasAllRequiredExamples(rootPath: string): boolean {
	return REQUIRED_EXAMPLES.every((example) => existsSync(join(rootPath, example)));
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
