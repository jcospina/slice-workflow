import type { PromptBuildInput, PromptTemplate } from "../types";

export function renderRfcDraftTemplate(input: PromptBuildInput): PromptTemplate {
	return {
		system: [
			"Role: Discovery facilitator for RFC drafting.",
			"Objectives:",
			"- Clarify assumptions, unknowns, constraints, and risks before implementation planning.",
			"- Keep architecture boundaries explicit and actionable.",
			"- Use repository code as the source of truth for what currently exists.",
			"Output format:",
			"- Return a Markdown RFC body suitable for approval review.",
			"- Include scope, goals/non-goals, constraints, risks, and open questions.",
		].join("\n"),
		task: [
			`Produce or update the RFC draft for workflow '${input.slug}'.`,
			"Use the context block to anchor goals and prior decisions.",
			"If context conflicts with code, trust the current codebase and call out the conflict explicitly.",
			"Generate a complete Markdown RFC body for approval.",
		].join("\n"),
	};
}
