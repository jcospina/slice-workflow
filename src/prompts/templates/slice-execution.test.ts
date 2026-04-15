import { describe, expect, it } from "vitest";
import { renderSliceExecutionTemplate } from "./slice-execution";

describe("renderSliceExecutionTemplate", () => {
	it("includes slice label in task when slice is provided", () => {
		const result = renderSliceExecutionTemplate({
			slug: "demo-slug",
			slice: { index: 2, name: "Data Layer", dod: "- Types defined." },
		});

		expect(result.task).toContain("Slice 02 - Data Layer");
	});

	it("uses 'Current slice' label when no slice is provided", () => {
		const result = renderSliceExecutionTemplate({ slug: "demo-slug" });

		expect(result.task).toContain("Current slice");
	});

	it("includes DoD in task when slice.dod is provided", () => {
		const result = renderSliceExecutionTemplate({
			slug: "demo-slug",
			slice: { index: 0, name: "Foundation", dod: "- Base files created." },
		});

		expect(result.task).toContain("DoD for this slice:\n- Base files created.");
	});

	it("falls back to derive-from-track-file message when dod is absent", () => {
		const result = renderSliceExecutionTemplate({
			slug: "demo-slug",
			slice: { index: 0, name: "Foundation", dod: "" },
		});

		expect(result.task).toContain("DoD not provided; derive it from current track file.");
	});

	it("includes boundary lines in system prompt when worktreeBoundary is set", () => {
		const result = renderSliceExecutionTemplate({
			slug: "demo-slug",
			worktreeBoundary: {
				worktreePath: "/worktrees/demo-slug-1",
				planDocPath: "implementations/demo-slug/demo-slug.md",
				progressDocPath: "implementations/demo-slug/PROGRESS.md",
				trackDocPath: "implementations/demo-slug/tracks/01-scaffold.md",
			},
		});

		expect(result.system).toContain("Worktree boundary:");
		expect(result.system).toContain("You are operating in worktree: /worktrees/demo-slug-1");
		expect(result.system).toContain("You MUST NOT modify files outside this worktree.");
		expect(result.system).toContain(
			"You MUST NOT modify these context files directly: implementations/demo-slug/demo-slug.md, implementations/demo-slug/tracks/01-scaffold.md.",
		);
		expect(result.system).toContain(
			"You may append observations to implementations/demo-slug/PROGRESS.md but must not overwrite it.",
		);
	});

	it("does not include boundary lines in system prompt when worktreeBoundary is omitted", () => {
		const result = renderSliceExecutionTemplate({
			slug: "demo-slug",
			slice: { index: 0, name: "Foundation", dod: "- Done." },
		});

		expect(result.system).not.toContain("Worktree boundary:");
		expect(result.system).not.toContain("You are operating in worktree:");
		expect(result.system).not.toContain("You MUST NOT modify files outside this worktree.");
	});

	it("does not include boundary lines when worktreeBoundary is undefined", () => {
		const result = renderSliceExecutionTemplate({
			slug: "demo-slug",
			worktreeBoundary: undefined,
		});

		expect(result.system).not.toContain("Worktree boundary:");
	});

	it("includes hard constraints in system prompt regardless of worktreeBoundary", () => {
		const withBoundary = renderSliceExecutionTemplate({
			slug: "demo-slug",
			worktreeBoundary: {
				worktreePath: "/wt",
				planDocPath: "impl/slug/slug.md",
				progressDocPath: "impl/slug/PROGRESS.md",
				trackDocPath: "impl/slug/tracks/00-foundation.md",
			},
		});
		const withoutBoundary = renderSliceExecutionTemplate({ slug: "demo-slug" });

		for (const result of [withBoundary, withoutBoundary]) {
			expect(result.system).toContain("Do NOT read other files in the tracks/ directory.");
			expect(result.system).toContain("Role: Slice implementer.");
		}
	});
});
