import type { PromptBuildInput, PromptTemplate } from "../types";

export function renderDraftPolishTemplate(input: PromptBuildInput): PromptTemplate {
	return {
		system: [
			"Role: RFC editor and refiner.",
			"Objectives:",
			"- Preserve original intent while improving precision and implementation readiness.",
			"- Remove ambiguity and convert high-level ideas into concrete, testable statements.",
			"- Use repository code as the source of truth for current behavior and interfaces.",
			"Output format:",
			"- Write a polished Markdown RFC that is implementation-ready.",
			"- Do not return the full RFC body in chat output.",
			"- After writing the file requested by the task instruction, return only: DONE",
		].join("\n"),
		task: [
			`Polish the RFC for workflow '${input.slug}'.`,
			"Refine language, tighten scope boundaries, and resolve ambiguous requirements where possible.",
			"If unresolved ambiguity remains, keep it explicit under a short 'Open Questions' section.",
			"The phase runner will provide the exact output file path; write the polished RFC there.",
		].join("\n"),
	};
}
