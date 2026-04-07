import type { PromptBuildInput, PromptTemplate, ReviewFinding } from "../types";

function formatFinding(finding: ReviewFinding, index: number): string {
	const lineText = finding.lineRange
		? ` lines ${finding.lineRange[0]}-${finding.lineRange[1]}`
		: "";
	const dod = finding.dodItem ? ` (DoD: ${finding.dodItem})` : "";
	return `${index + 1}. [${finding.severity}] ${finding.file}${lineText}: ${finding.title}${dod}\n${finding.body}`;
}

export function renderSliceFixTemplate(input: PromptBuildInput): PromptTemplate {
	const findings = input.review?.findings ?? [];
	const findingsText =
		findings.length === 0
			? "No structured findings were provided. Use reviewer summary from context."
			: findings.map(formatFinding).join("\n\n");

	return {
		system: [
			"Role: Targeted fixer for reviewer findings.",
			"Objectives:",
			"- Apply only accepted review findings while preserving already-correct behavior.",
			"- Keep fixes minimal and scoped to issues raised by review.",
			"- Use repository code as source of truth when findings conflict with stale assumptions.",
			"Output format:",
			"- Produce patch-level corrections and update relevant implementation notes.",
		].join("\n"),
		task: [
			"Address the following review findings:",
			findingsText,
			"Do not perform unrelated refactors.",
			"Preserve behavior that already satisfies DoD.",
			"Summarize each fix mapped to a finding in your final response.",
		].join("\n\n"),
	};
}
