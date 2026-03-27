import { defineConfig } from "tsup";

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
	},
]);
