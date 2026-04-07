import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

const BUNDLED_EXAMPLES = [
	{
		name: "decouple-data-layer",
		source: "implementations/decouple-data-layer",
	},
	{
		name: "income-tracking",
		source: "implementations/income-tracking",
	},
] as const;

function copyBundledExamples(outDir: string): void {
	const examplesOutDir = resolve(outDir, "examples");
	rmSync(examplesOutDir, { recursive: true, force: true });
	mkdirSync(examplesOutDir, { recursive: true });

	for (const example of BUNDLED_EXAMPLES) {
		const sourcePath = resolve(example.source);
		if (!existsSync(sourcePath)) {
			throw new Error(`Missing bundled example source directory: ${sourcePath}`);
		}

		const destinationPath = resolve(examplesOutDir, example.name);
		cpSync(sourcePath, destinationPath, { recursive: true });
	}
}

export default defineConfig([
	{
		entry: ["bin/slice.ts"],
		format: ["esm"],
		target: "es2022",
		outDir: "dist/bin",
		clean: true,
		sourcemap: true,
		banner: {
			js: "#!/usr/bin/env node",
		},
	},
	{
		entry: ["src/index.ts"],
		format: ["esm"],
		target: "es2022",
		outDir: "dist",
		clean: false,
		dts: true,
		sourcemap: true,
		splitting: true,
		onSuccess: () => {
			copyBundledExamples("dist");
		},
	},
]);
