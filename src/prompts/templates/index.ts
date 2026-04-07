import type { PromptBuildInput, PromptTemplate, PromptTemplatePhase } from "../types";
import { renderDraftPolishTemplate } from "./draft-polish";
import { renderHandoffTemplate } from "./handoff";
import { renderPlanTemplate } from "./plan";
import { renderRfcDraftTemplate } from "./rfc-draft";
import { renderSliceExecutionTemplate } from "./slice-execution";
import { renderSliceFixTemplate } from "./slice-fix";
import { renderSliceReviewTemplate } from "./slice-review";

type TemplateRenderer = (input: PromptBuildInput) => PromptTemplate;

const TEMPLATE_RENDERERS: Record<PromptTemplatePhase, TemplateRenderer> = {
	"rfc-draft": renderRfcDraftTemplate,
	"draft-polish": renderDraftPolishTemplate,
	plan: renderPlanTemplate,
	"slice-execution": renderSliceExecutionTemplate,
	"slice-review": renderSliceReviewTemplate,
	"slice-fix": renderSliceFixTemplate,
	handoff: renderHandoffTemplate,
};

export function renderTemplate(
	phase: PromptTemplatePhase,
	input: PromptBuildInput,
): PromptTemplate {
	return TEMPLATE_RENDERERS[phase](input);
}
