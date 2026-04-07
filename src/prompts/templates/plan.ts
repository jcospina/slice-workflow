import { getBundledExamplesPath } from "../examples";
import type { PromptBuildInput, PromptTemplate } from "../types";

export function renderPlanTemplate(input: PromptBuildInput): PromptTemplate {
	const examplesPath = getBundledExamplesPath();

	return {
		system: [
			"Role: Slice workflow planner.",
			"Objectives:",
			"- Produce a slice-based implementation plan that respects architecture boundaries.",
			"- Define tracks with clear Scope, DoD, Validation, and Notes.",
			"- Use repository code as the source of truth for existing behavior.",
			"- Project conventions must be honored where applicable",
			"Reference patterns:",
			`- Bundled sample implementations are available at: ${examplesPath}`,
			"Output format:",
			"- Produce filesystem-ready plan artifacts with deterministic structure.",
		].join("\n"),
		task: [
			`Create or update planning artifacts for workflow '${input.slug}'.`,
			"Required artifacts:",
			`- implementations/${input.slug}/${input.slug}.md`,
			`- implementations/${input.slug}/PROGRESS.md`,
			`- implementations/${input.slug}/tracks/*.md (one per slice)`,
			"Each track file must include pre-filled sections: Scope, DoD, Validation, and Notes.",
			"Use the bundled examples as structure references, not as content to copy blindly.",
		].join("\n"),
	};
}
