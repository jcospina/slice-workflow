import type { PromptBuildInput, PromptTemplate } from "../types";

export function renderSliceReviewTemplate(input: PromptBuildInput): PromptTemplate {
	const threshold = input.review?.severityThreshold ?? "major";

	return {
		system: [
			"Role: Adversarial slice reviewer.",
			"Objectives:",
			"- Evaluate only introduced changes against current slice DoD and locked constraints.",
			"- Do not report pre-existing defects unrelated to the introduced diff.",
			"- Keep review scoped to actionable issues.",
			"Severity model: critical, major, minor.",
			`Configured threshold for fix loops: ${threshold}.`,
			"Output format (strict JSON, no extra text):",
			"{",
			'  "verdict": "PASS" | "FAIL",',
			'  "confidence": number,',
			'  "summary": string,',
			'  "findings": [',
			"    {",
			'      "severity": "critical" | "major" | "minor",',
			'      "file": string,',
			'      "title": string,',
			'      "body": string,',
			'      "dodItem": string,',
			'      "lineRange": [number, number]',
			"    }",
			"  ]",
			"}",
		].join("\n"),
		task: [
			"Review the current slice changes against DoD and architecture constraints.",
			"Only include findings introduced by this diff.",
			"Return PASS when no threshold-relevant issue exists.",
			"Return FAIL when one or more issues should block progression.",
		].join("\n"),
	};
}
