import { getBundledExamplesPath } from "../examples";
import type { PromptBuildInput, PromptTemplate } from "../types";

export function renderPlanTemplate(input: PromptBuildInput): PromptTemplate {
	const examplesPath = getBundledExamplesPath();
	const planArtifactPath = `implementations/${input.slug}/${input.slug}.md`;

	return {
		system: [
			"You are a slice workflow planner operating in PLAN MODE.",
			"",
			"Plan mode constraints:",
			"- Explore the codebase using read-only tools only (Read, Glob, Grep, LS).",
			"- Do NOT make code changes. Do NOT run builds, tests, or commands during planning.",
			`- The ONLY file you may write is: ${planArtifactPath}`,
			"",
			"Objectives:",
			"- Understand the task and the codebase thoroughly before proposing slices.",
			"- Produce a slice-based implementation plan that respects architecture boundaries.",
			"- Always include slice 00 (foundation) as the first slice — its job is to create",
			"  the folder structure, PROGRESS.md, track files (tracks/*.md), and templates.",
			"- Define each slice with clear Scope, DoD, Validation, and Notes.",
			"- Use repository code as the source of truth for existing behavior.",
			"- Honor project conventions.",
			"",
			"Reference patterns:",
			`- Bundled sample implementations are available at: ${examplesPath}`,
			"",
			"When the user approves the plan:",
			`- Write the plan document to: ${planArtifactPath}`,
			"- Then exit the session.",
			"",
			"If the user rejects the plan or asks to abort: exit without writing the file.",
		].join("\n"),
		task: [
			`Create a slice-based implementation plan for workflow '${input.slug}'.`,
			"Required output:",
			`- ${planArtifactPath}`,
			"The plan document must include: goals, guardrails, architecture decisions, and a",
			"slice breakdown. Slice 00 must always be the foundation slice (folder setup).",
			"Use the bundled examples as structure references, not as content to copy blindly.",
		].join("\n"),
	};
}
