import { join } from "node:path";
import type { PhaseContext, PromptBuilder } from "../orchestrator/phases/types";
import type { PhaseName } from "../state/types";
import {
	type ContextBlockResult,
	buildContextBlock,
	buildContextBlockFromContent,
} from "./context";
import { renderTemplate } from "./templates";
import type {
	BuiltPrompt,
	PromptBuildInput,
	PromptContextFiles,
	PromptTemplatePhase,
} from "./types";

export {
	ContextBudgetExceededError,
	buildContextBlock,
	buildContextBlockFromContent,
	type BuildContextBlockOptions,
	type ContextBlockResult,
} from "./context";
export {
	DEFAULT_CONTEXT_BUDGET_CHARS,
	type BuiltPrompt,
	type PromptBuildInput,
	type PromptContextFiles,
	type PromptLayers,
	type PromptReviewContext,
	type PromptSliceContext,
	type PromptTemplate,
	type PromptTemplatePhase,
	type ReviewFinding,
	type ReviewSeverity,
	type WorktreeBoundary,
} from "./types";

export function mapPhaseToTemplatePhase(phase: PhaseName): PromptTemplatePhase {
	if (phase === "execute") {
		return "slice-execution";
	}
	return phase;
}

export function createPromptBuilder(): PromptBuilder {
	return new DefaultPromptBuilder();
}

export class DefaultPromptBuilder implements PromptBuilder {
	async buildPrompt(phase: PromptTemplatePhase, input: PromptBuildInput): Promise<BuiltPrompt> {
		const template = renderTemplate(phase, input);
		const context = await this.resolveContextLayer(input);
		const layers = {
			system: template.system,
			context: context.text,
			task: template.task,
		};

		const sections = [
			`System prompt:\n${layers.system}`,
			layers.context ? `Context block:\n${layers.context}` : "",
			`Task prompt:\n${layers.task}`,
		].filter(Boolean);

		return {
			phase,
			layers,
			composedPrompt: sections.join("\n\n"),
		};
	}

	async buildSystemPrompt(phase: PhaseName, ctx: PhaseContext): Promise<string> {
		const prompt = await this.buildPrompt(mapPhaseToTemplatePhase(phase), {
			...this.toBuildInput(ctx),
			includeContext: false,
		});
		return prompt.layers.system;
	}

	async buildTaskPrompt(phase: PhaseName, ctx: PhaseContext): Promise<string> {
		const prompt = await this.buildPrompt(mapPhaseToTemplatePhase(phase), {
			...this.toBuildInput(ctx),
			includeContext: false,
		});
		return prompt.layers.task;
	}

	private async resolveContextLayer(input: PromptBuildInput): Promise<ContextBlockResult> {
		if (input.includeContext === false) {
			return { text: "", charCount: 0, maxChars: input.maxContextChars ?? 0 };
		}

		if (input.preReadContent) {
			return buildContextBlockFromContent(input.preReadContent, input.maxContextChars);
		}

		if (!input.files) {
			throw new Error(
				"buildPrompt requires either preReadContent or files (planPath, progressPath, currentTrackPath).",
			);
		}

		return await buildContextBlock({
			files: input.files,
			maxChars: input.maxContextChars,
		});
	}

	private toBuildInput(ctx: PhaseContext): PromptBuildInput {
		return {
			slug: ctx.run.slug,
			runId: ctx.runId,
			taskDescription: ctx.run.taskDescription,
			topLevelPhase: ctx.phase,
			files: deriveDefaultPromptFiles(ctx),
		};
	}
}

export function deriveDefaultPromptFiles(
	ctx: Pick<PhaseContext, "implementationsDir" | "run">,
): PromptContextFiles {
	const root = join(ctx.implementationsDir, ctx.run.slug);
	return {
		planPath: join(root, `${ctx.run.slug}.md`),
		progressPath: join(root, "PROGRESS.md"),
		currentTrackPath: join(root, "tracks", "00-foundation.md"),
	};
}
