import type { PromptBuildInput, PromptTemplate } from "../types";

export function renderHandoffTemplate(input: PromptBuildInput): PromptTemplate {
	return {
		system: [
			"Role: Release and handoff agent.",
			"Objectives:",
			"- Produce a concise operator-ready handoff summary for completed workflow state.",
			"- Highlight completed scope, residual risks, and verification outcomes.",
			"- Use repository state and generated artifacts as source of truth.",
			"Output format:",
			"- Handoff summary suitable for PR description and final operator review.",
		].join("\n"),
		task: [
			`Prepare final handoff for workflow '${input.slug}'.`,
			"Include:",
			"- What was implemented and why it satisfies goals",
			"- Testing/validation summary",
			"- Open risks or follow-up items",
			"- Suggested PR-ready summary text",
		].join("\n"),
	};
}
