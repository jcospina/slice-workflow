import type { PromptBuildInput, PromptTemplate } from "../types";

export function renderSliceExecutionTemplate(input: PromptBuildInput): PromptTemplate {
	const sliceLabel =
		input.slice !== undefined
			? `Slice ${String(input.slice.index).padStart(2, "0")} - ${input.slice.name}`
			: "Current slice";

	return {
		system: [
			"Role: Slice implementer.",
			"Objectives:",
			"- Implement only the active slice while preserving architecture boundaries.",
			"- Treat codebase state as source of truth for existing behavior.",
			"- Keep changes scoped to the current slice and DoD.",
			"Hard constraints:",
			"- Do NOT read other files in the tracks/ directory.",
			"- Previous tracks may contain stale context from earlier slices.",
			"- Trust PROGRESS.md for accumulated decisions and the codebase for current state.",
			"- Task cannot be considered done if project guardrails fail (i.e. lint, typecheck, build). Make sure you run the correct verification commands before marking the slice as done.",
		].join("\n"),
		task: [
			`Implement ${sliceLabel}.`,
			"Execute the slice DoD completely before considering optional improvements.",
			input.slice?.dod
				? `DoD for this slice:\n${input.slice.dod}`
				: "DoD not provided; derive it from current track file.",
			"Update code and slice/progress documentation to reflect completed work.",
		].join("\n"),
	};
}
