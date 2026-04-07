// --- Status union types ---

export type WorkflowStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type PhaseName = "rfc-draft" | "draft-polish" | "plan" | "execute" | "review" | "handoff";

export type PhaseStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type SliceStatus = "pending" | "running" | "completed" | "failed" | "awaiting_approval";

export type ReviewVerdict = "PASS" | "FAIL";

export type NotificationChannel = "slack" | "telegram" | "tui";

// --- Record interfaces ---

export interface WorkflowRun {
	id: string;
	taskDescription: string;
	slug: string;
	status: WorkflowStatus;
	currentPhase: PhaseName | null;
	baseBranch: string;
	workingBranch: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface PhaseRecord {
	id: string;
	runId: string;
	phase: PhaseName;
	status: PhaseStatus;
	agentSessionId: string | null;
	costUsd: number | null;
	durationMs: number | null;
	error: string | null;
	startedAt: string | null;
	endedAt: string | null;
	createdAt: string;
}

export interface SliceRecord {
	id: string;
	runId: string;
	index: number;
	name: string;
	status: SliceStatus;
	agentSessionId: string | null;
	costUsd: number | null;
	durationMs: number | null;
	error: string | null;
	startedAt: string | null;
	endedAt: string | null;
	createdAt: string;
}

export interface ReviewResult {
	id: string;
	runId: string;
	sliceIndex: number;
	iteration: number;
	verdict: ReviewVerdict;
	confidence: number;
	findings: string;
	summary: string;
	reviewerSessionId: string | null;
	costUsd: number | null;
	createdAt: string;
}

export interface NotificationLog {
	id: string;
	runId: string;
	channel: NotificationChannel;
	eventType: string;
	payload: string;
	userResponse: string | null;
	sentAt: string;
	respondedAt: string | null;
}

// --- Create input types (omit generated fields) ---

export type CreateWorkflowRun = Omit<WorkflowRun, "id" | "createdAt" | "updatedAt">;

export type CreatePhaseRecord = Omit<PhaseRecord, "id" | "createdAt">;

export type CreateSliceRecord = Omit<SliceRecord, "id" | "createdAt">;

export type CreateReviewResult = Omit<ReviewResult, "id" | "createdAt">;

export type CreateNotificationLog = Omit<NotificationLog, "id">;

// --- Update input types (partial mutable fields) ---

export type UpdateWorkflowRun = Partial<
	Pick<WorkflowRun, "status" | "currentPhase" | "workingBranch">
>;

export type UpdatePhaseRecord = Partial<
	Pick<
		PhaseRecord,
		"status" | "agentSessionId" | "costUsd" | "durationMs" | "error" | "startedAt" | "endedAt"
	>
>;

export type UpdateSliceRecord = Partial<
	Pick<
		SliceRecord,
		"status" | "agentSessionId" | "costUsd" | "durationMs" | "error" | "startedAt" | "endedAt"
	>
>;

export type UpdateNotificationLog = Partial<Pick<NotificationLog, "userResponse" | "respondedAt">>;

// --- Aggregate types ---

export interface RunCostSummary {
	totalCostUsd: number;
	totalDurationMs: number;
	slicesCompleted: number;
	slicesTotal: number;
}

export interface ResumeContext {
	run: WorkflowRun;
	phases: PhaseRecord[];
	slices: SliceRecord[];
	reviews: ReviewResult[];
}
