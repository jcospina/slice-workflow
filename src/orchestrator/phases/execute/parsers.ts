import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewFinding } from "../../../prompts/types";
import type { ReviewVerdict } from "../../../state/types";
import type { ParsedReview, SliceDefinition } from "./types";

/** Pure parser for `### Slice NN - Name` sections in plan docs. */
export function parsePlanSlices(content: string): SliceDefinition[] {
	const headerMatches = [...content.matchAll(/^### Slice (\d+) - (.+)$/gm)].map((m) => ({
		index: Number.parseInt(m[1], 10),
		name: m[2].trim(),
		contentStart: m.index + m[0].length,
		pos: m.index,
	}));

	return headerMatches.map((match, i) => {
		const sectionEnd = i + 1 < headerMatches.length ? headerMatches[i + 1].pos : content.length;
		const sectionBody = content.slice(match.contentStart, sectionEnd);

		const dodMarker = "Definition of Done:";
		const dodPos = sectionBody.indexOf(dodMarker);
		const dod = dodPos >= 0 ? sectionBody.slice(dodPos + dodMarker.length).trim() : "";

		return { index: match.index, name: match.name, dod };
	});
}

/** Finds `NN-*.md` track files and returns the first absolute match path. */
export async function findTrackFile(tracksDir: string, sliceIndex: number): Promise<string | null> {
	const prefix = `${String(sliceIndex).padStart(2, "0")}-`;
	try {
		const entries = await readdir(tracksDir);
		const match = entries.find((f) => f.startsWith(prefix) && f.endsWith(".md"));
		return match ? join(tracksDir, match) : null;
	} catch {
		return null;
	}
}

const JSON_BLOCK_RE = /\{[\s\S]*\}/;

/** Extracts strict review JSON payload from reviewer output. */
export function parseReviewOutput(output: string): ParsedReview | null {
	const jsonMatch = output.match(JSON_BLOCK_RE);
	if (!jsonMatch) {
		return null;
	}
	try {
		const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
		const verdict = parsed.verdict as string;
		if (verdict !== "PASS" && verdict !== "FAIL" && verdict !== "PARTIAL") {
			return null;
		}
		return {
			verdict: verdict as ReviewVerdict,
			confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
			summary: typeof parsed.summary === "string" ? parsed.summary : "",
			findings: Array.isArray(parsed.findings) ? (parsed.findings as ReviewFinding[]) : [],
		};
	} catch {
		return null;
	}
}
