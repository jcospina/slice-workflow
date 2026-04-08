import { describe, expect, it, vi } from "vitest";
import { createInMemoryStateManager } from "../state";
import type { PhaseName } from "../state/types";
import { PhaseError, StateError } from "../utils/errors";
import { WorkflowOrchestrator, canTransition, createWorkflowOrchestrator } from "./index";
import type {
	ApprovalResponse,
	MessagingManager,
	PhaseContext,
	PhaseHandler,
	PhaseResult,
	PromptBuilder,
	WorktreeManager,
} from "./phases/types";

// --- Helpers ---

function makeHandler(result?: Partial<PhaseResult>): PhaseHandler {
	return vi.fn(async (_ctx: PhaseContext) => ({
		status: "completed" as const,
		agentSessionId: "sess-1",
		costUsd: 0.1,
		durationMs: 500,
		error: null,
		output: null,
		...result,
	}));
}

function makeMocks() {
	const worktree: WorktreeManager = {
		create: vi.fn().mockResolvedValue("/tmp/worktree"),
		setup: vi.fn().mockResolvedValue(undefined),
		remove: vi.fn().mockResolvedValue(undefined),
		prune: vi.fn().mockResolvedValue(undefined),
	};

	const approvalResponse: ApprovalResponse = {
		decision: "approved",
		feedback: null,
		respondedAt: new Date().toISOString(),
		channel: "tui",
	};

	const messaging: MessagingManager = {
		requestApproval: vi.fn().mockResolvedValue(approvalResponse),
		notify: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
	};

	const prompts: PromptBuilder = {
		buildPrompt: vi.fn().mockResolvedValue({
			phase: "plan",
			layers: { system: "system", context: "context", task: "task" },
			composedPrompt: "system\n\ncontext\n\ntask",
		}),
		buildSystemPrompt: vi.fn().mockResolvedValue("system"),
		buildTaskPrompt: vi.fn().mockResolvedValue("task"),
	};

	return { worktree, messaging, prompts };
}

const BASE_CONFIG = {
	provider: "claude-code" as const,
	providers: { claudeCode: {}, opencode: {} },
	messaging: {},
	implementationsDir: "implementations",
	approvalGates: { rfc: false, plan: false },
	sliceExecution: "autonomous" as const,
	review: {
		enabled: true,
		maxIterations: 2,
		severityThreshold: "major" as const,
	},
};

const MOCK_RUNTIME = {
	provider: "claude-code" as const,
	run: vi.fn(),
	runInteractive: vi.fn(),
};

function makeAllHandlers(): Partial<Record<PhaseName, PhaseHandler>> {
	return {
		"rfc-draft": makeHandler(),
		"draft-polish": makeHandler(),
		plan: makeHandler(),
		execute: makeHandler(),
		handoff: makeHandler(),
	};
}

// --- Tests ---

describe("canTransition", () => {
	it("allows null → rfc-draft (fresh start)", () => {
		expect(canTransition(null, "rfc-draft")).toBe(true);
	});

	it("disallows null → any phase other than rfc-draft", () => {
		expect(canTransition(null, "draft-polish")).toBe(false);
		expect(canTransition(null, "plan")).toBe(false);
		expect(canTransition(null, "execute")).toBe(false);
		expect(canTransition(null, "handoff")).toBe(false);
	});

	it("allows sequential forward transitions", () => {
		expect(canTransition("rfc-draft", "draft-polish")).toBe(true);
		expect(canTransition("draft-polish", "plan")).toBe(true);
		expect(canTransition("plan", "execute")).toBe(true);
		expect(canTransition("execute", "handoff")).toBe(true);
	});

	it("disallows skipping phases", () => {
		expect(canTransition("rfc-draft", "plan")).toBe(false);
		expect(canTransition("rfc-draft", "execute")).toBe(false);
		expect(canTransition("draft-polish", "execute")).toBe(false);
		expect(canTransition("plan", "handoff")).toBe(false);
	});

	it("rejects top-level review transitions", () => {
		expect(canTransition("execute", "review" as unknown as PhaseName)).toBe(false);
		expect(canTransition("review" as unknown as PhaseName, "execute")).toBe(false);
		expect(canTransition("review" as unknown as PhaseName, "handoff")).toBe(false);
	});

	it("disallows backward transitions", () => {
		expect(canTransition("draft-polish", "rfc-draft")).toBe(false);
		expect(canTransition("handoff", "rfc-draft")).toBe(false);
		expect(canTransition("execute", "plan")).toBe(false);
	});

	it("allows same-phase transition (resume re-run)", () => {
		for (const phase of [
			"rfc-draft",
			"draft-polish",
			"plan",
			"execute",
			"handoff",
		] as PhaseName[]) {
			expect(canTransition(phase, phase)).toBe(true);
		}
	});
});

describe("WorkflowOrchestrator constructor", () => {
	it("instantiates without error", () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();

		expect(
			() =>
				new WorkflowOrchestrator({
					config: BASE_CONFIG,
					runtime: MOCK_RUNTIME,
					state,
					...mocks,
					projectCwd: "/project",
				}),
		).not.toThrow();

		state.close();
	});

	it("throws not-yet-implemented when an unimplemented default phase is reached", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: {
				"rfc-draft": makeHandler(),
				"draft-polish": makeHandler(),
			},
		});

		// plan remains unimplemented in defaults.
		await expect(orch.run("test task")).rejects.toThrow(PhaseError);
		await expect(orch.run("test task")).rejects.toThrow("not yet implemented");

		state.close();
	});
});

describe("createWorkflowOrchestrator factory", () => {
	it("returns a WorkflowOrchestrator instance", () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();

		const orch = createWorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
		});

		expect(orch).toBeInstanceOf(WorkflowOrchestrator);
		state.close();
	});
});

describe("run() - fresh start", () => {
	it("creates a WorkflowRun in SQLite and marks it completed", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: makeAllHandlers(),
		});

		await orch.run("implement feature X");

		const runs = state.runs.list();
		expect(runs).toHaveLength(1);
		expect(runs[0].taskDescription).toBe("implement feature X");
		expect(runs[0].status).toBe("completed");

		state.close();
	});

	it("calls all five top-level phase handlers in order", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();
		const callOrder: PhaseName[] = [];

		const result: PhaseResult = {
			status: "completed",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			error: null,
			output: null,
		};
		const phases: Partial<Record<PhaseName, PhaseHandler>> = {
			"rfc-draft": vi.fn((ctx) => {
				callOrder.push(ctx.phase);
				return Promise.resolve(result);
			}),
			"draft-polish": vi.fn((ctx) => {
				callOrder.push(ctx.phase);
				return Promise.resolve(result);
			}),
			plan: vi.fn((ctx) => {
				callOrder.push(ctx.phase);
				return Promise.resolve(result);
			}),
			execute: vi.fn((ctx) => {
				callOrder.push(ctx.phase);
				return Promise.resolve(result);
			}),
			handoff: vi.fn((ctx) => {
				callOrder.push(ctx.phase);
				return Promise.resolve(result);
			}),
		};

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases,
		});

		await orch.run("test");

		expect(callOrder).toEqual(["rfc-draft", "draft-polish", "plan", "execute", "handoff"]);
		state.close();
	});

	it("creates a PhaseRecord for each phase", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: makeAllHandlers(),
		});

		await orch.run("test");

		const runs = state.runs.list();
		const phases = state.phases.listByRun(runs[0].id);
		expect(phases).toHaveLength(5);
		expect(phases.map((p) => p.phase)).toEqual([
			"rfc-draft",
			"draft-polish",
			"plan",
			"execute",
			"handoff",
		]);
		expect(phases.every((p) => p.status === "completed")).toBe(true);

		state.close();
	});

	it("fires phase_started and phase_completed events for each phase", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();
		const events: string[] = [];

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: makeAllHandlers(),
			onEvent: (e) => events.push(e.type),
		});

		await orch.run("test");

		const phaseNames = ["rfc-draft", "draft-polish", "plan", "execute", "handoff"];
		for (const _phase of phaseNames) {
			expect(events).toContain("phase_started");
			expect(events).toContain("phase_completed");
		}
		expect(events[events.length - 1]).toBe("workflow_completed");

		state.close();
	});

	it("fires workflow_completed with totalCostUsd", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();
		const completedEvent: { totalCostUsd?: number } = {};

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: makeAllHandlers(),
			onEvent: (e) => {
				if (e.type === "workflow_completed") {
					completedEvent.totalCostUsd = e.totalCostUsd;
				}
			},
		});

		await orch.run("test");
		expect(typeof completedEvent.totalCostUsd).toBe("number");

		state.close();
	});

	it("passes a populated PhaseContext to each handler", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();
		let capturedCtx: PhaseContext | undefined;

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: {
				...makeAllHandlers(),
				"rfc-draft": (ctx) => {
					capturedCtx = ctx;
					return Promise.resolve({
						status: "completed" as const,
						agentSessionId: null,
						costUsd: null,
						durationMs: null,
						error: null,
						output: null,
					});
				},
			},
		});

		await orch.run("feature Y");

		expect(capturedCtx).toBeDefined();
		expect(capturedCtx?.phase).toBe("rfc-draft");
		expect(capturedCtx?.run.taskDescription).toBe("feature Y");
		expect(capturedCtx?.projectCwd).toBe("/project");
		expect(capturedCtx?.resumeContext).toBeUndefined();

		state.close();
	});

	it("does not invoke top-level review handlers", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();
		const reviewHandler = vi.fn(async () => ({
			status: "completed" as const,
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			error: null,
			output: null,
		}));

		const phasesWithReviewOverride = {
			...(makeAllHandlers() as Record<string, PhaseHandler>),
			review: reviewHandler,
		} as Partial<Record<PhaseName, PhaseHandler>>;

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: phasesWithReviewOverride,
		});

		await orch.run("feature Z");
		expect(reviewHandler).not.toHaveBeenCalled();

		state.close();
	});

	it("passes review config to execute handlers", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();
		let executeCtx: PhaseContext | undefined;

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: {
				...makeAllHandlers(),
				execute: vi.fn((ctx) => {
					executeCtx = ctx;
					return Promise.resolve({
						status: "completed" as const,
						agentSessionId: null,
						costUsd: null,
						durationMs: null,
						error: null,
						output: null,
					});
				}),
			},
		});

		await orch.run("execute review contract");
		expect(executeCtx?.config.review.enabled).toBe(true);
		expect(executeCtx?.config.review.maxIterations).toBe(2);
		expect(executeCtx?.config.review.severityThreshold).toBe("major");

		state.close();
	});
});

describe("run() - crash recovery (resume)", () => {
	it("skips already-completed phases and resumes from the first incomplete one", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();

		// Pre-populate: rfc-draft completed; currentPhase advanced to draft-polish
		// (the orchestrator always sets currentPhase before running a phase, so by
		// the time rfc-draft has a completed record, currentPhase = "draft-polish")
		const run = state.runs.create({
			taskDescription: "resume task",
			slug: "resume-task",
			status: "running",
			currentPhase: "draft-polish",
			baseBranch: "main",
			workingBranch: null,
		});
		state.phases.create({
			runId: run.id,
			phase: "rfc-draft",
			status: "completed",
			agentSessionId: "old-sess",
			costUsd: 0.05,
			durationMs: 300,
			error: null,
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
		});

		const rfcDraftHandler = makeHandler();
		const draftPolishHandler = makeHandler();

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: {
				"rfc-draft": rfcDraftHandler,
				"draft-polish": draftPolishHandler,
				plan: makeHandler(),
				execute: makeHandler(),
				handoff: makeHandler(),
			},
		});

		await orch.run("resume task");

		// rfc-draft was already complete — handler should not be called again
		expect(rfcDraftHandler).not.toHaveBeenCalled();
		// draft-polish and beyond should run
		expect(draftPolishHandler).toHaveBeenCalledOnce();

		state.close();
	});

	it("passes the resume context to handlers", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();

		const run = state.runs.create({
			taskDescription: "resume ctx task",
			slug: "resume-ctx-task",
			status: "running",
			currentPhase: "rfc-draft",
			baseBranch: "main",
			workingBranch: null,
		});
		state.phases.create({
			runId: run.id,
			phase: "rfc-draft",
			status: "completed",
			agentSessionId: null,
			costUsd: null,
			durationMs: null,
			error: null,
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
		});

		let capturedResumeCtx: PhaseContext["resumeContext"] | undefined;

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: {
				...makeAllHandlers(),
				"draft-polish": (ctx) => {
					capturedResumeCtx = ctx.resumeContext;
					return Promise.resolve({
						status: "completed" as const,
						agentSessionId: null,
						costUsd: null,
						durationMs: null,
						error: null,
						output: null,
					});
				},
			},
		});

		await orch.run("resume ctx task");

		expect(capturedResumeCtx).toBeDefined();
		expect(capturedResumeCtx?.run.id).toBe(run.id);

		state.close();
	});
});

describe("run() - phase error handling", () => {
	it("marks PhaseRecord as failed and WorkflowRun as failed when handler throws", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: {
				"rfc-draft": () => Promise.reject(new Error("agent crash")),
			},
		});

		await expect(orch.run("failing task")).rejects.toThrow("agent crash");

		const runs = state.runs.list();
		expect(runs[0].status).toBe("failed");

		const phases = state.phases.listByRun(runs[0].id);
		expect(phases[0].status).toBe("failed");
		expect(phases[0].error).toBe("agent crash");

		state.close();
	});

	it("fires phase_failed and workflow_failed events", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();
		const events: string[] = [];

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: {
				"rfc-draft": () => Promise.reject(new Error("boom")),
			},
			onEvent: (e) => events.push(e.type),
		});

		await expect(orch.run("test")).rejects.toThrow();

		expect(events).toContain("phase_failed");
		expect(events).toContain("workflow_failed");

		state.close();
	});

	it("calls messaging.notify with phase_failed event on phase error", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: {
				"rfc-draft": () => Promise.reject(new Error("notify me")),
			},
		});

		await expect(orch.run("test")).rejects.toThrow();

		expect(mocks.messaging.notify).toHaveBeenCalledWith(
			expect.objectContaining({ type: "phase_failed" }),
		);

		state.close();
	});

	it("re-throws the original error to the caller", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();
		const originalError = new Error("original");

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: {
				"rfc-draft": () => Promise.reject(originalError),
			},
		});

		await expect(orch.run("test")).rejects.toBe(originalError);

		state.close();
	});
});

describe("run() - approval gates", () => {
	it("calls messaging.requestApproval after rfc-draft when gate is enabled", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();

		const config = { ...BASE_CONFIG, approvalGates: { rfc: true, plan: false } };

		const orch = new WorkflowOrchestrator({
			config,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: makeAllHandlers(),
		});

		await orch.run("test");

		expect(mocks.messaging.requestApproval).toHaveBeenCalledOnce();
		expect(mocks.messaging.requestApproval).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "rfc-draft" }),
		);

		state.close();
	});

	it("calls messaging.requestApproval after plan when gate is enabled", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();

		const config = { ...BASE_CONFIG, approvalGates: { rfc: false, plan: true } };

		const orch = new WorkflowOrchestrator({
			config,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: makeAllHandlers(),
		});

		await orch.run("test");

		expect(mocks.messaging.requestApproval).toHaveBeenCalledOnce();
		expect(mocks.messaging.requestApproval).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "plan" }),
		);

		state.close();
	});

	it("does not call requestApproval when gates are disabled", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG, // gates both false
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: makeAllHandlers(),
		});

		await orch.run("test");

		expect(mocks.messaging.requestApproval).not.toHaveBeenCalled();

		state.close();
	});

	it("cancels the run when requestApproval returns rejected", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();

		const rejectedResponse: ApprovalResponse = {
			decision: "rejected",
			feedback: null,
			respondedAt: new Date().toISOString(),
			channel: "tui",
		};
		vi.mocked(mocks.messaging.requestApproval).mockResolvedValueOnce(rejectedResponse);

		const config = { ...BASE_CONFIG, approvalGates: { rfc: true, plan: false } };

		const orch = new WorkflowOrchestrator({
			config,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: makeAllHandlers(),
		});

		await orch.run("test");

		const runs = state.runs.list();
		expect(runs[0].status).toBe("cancelled");

		state.close();
	});

	it("reruns rfc-draft when requestApproval returns request_changes at RFC gate", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();

		const requestChangesResponse: ApprovalResponse = {
			decision: "request_changes",
			feedback: "Please add more detail to the RFC",
			respondedAt: new Date().toISOString(),
			channel: "tui",
		};

		vi.mocked(mocks.messaging.requestApproval)
			.mockResolvedValueOnce(requestChangesResponse)
			.mockResolvedValueOnce({
				decision: "approved",
				feedback: null,
				respondedAt: new Date().toISOString(),
				channel: "tui",
			});

		const config = { ...BASE_CONFIG, approvalGates: { rfc: true, plan: false } };
		const rfcDraftHandler = makeHandler();
		const draftPolishHandler = makeHandler();

		const orch = new WorkflowOrchestrator({
			config,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: {
				...makeAllHandlers(),
				"rfc-draft": rfcDraftHandler,
				"draft-polish": draftPolishHandler,
			},
		});

		await orch.run("test");

		expect(rfcDraftHandler).toHaveBeenCalledTimes(2);
		expect(draftPolishHandler).toHaveBeenCalledTimes(1);
		expect(mocks.messaging.requestApproval).toHaveBeenCalledTimes(2);
		expect(state.runs.list()[0].status).toBe("completed");

		const responses = state.notifications
			.listByRun(state.runs.list()[0].id)
			.filter((n) => n.eventType === "approval_response");
		expect(responses).toHaveLength(2);
		expect(
			responses.some((entry) => {
				const payload = JSON.parse(entry.payload) as {
					decision?: string;
					feedback?: string | null;
				};
				return (
					payload.decision === "request_changes" &&
					payload.feedback === requestChangesResponse.feedback
				);
			}),
		).toBe(true);

		state.close();
	});

	it("reruns plan when requestApproval returns request_changes at Plan gate", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();

		vi.mocked(mocks.messaging.requestApproval)
			.mockResolvedValueOnce({
				decision: "request_changes",
				feedback: "Adjust scope and sequencing",
				respondedAt: new Date().toISOString(),
				channel: "tui",
			})
			.mockResolvedValueOnce({
				decision: "approved",
				feedback: null,
				respondedAt: new Date().toISOString(),
				channel: "tui",
			});

		const config = { ...BASE_CONFIG, approvalGates: { rfc: false, plan: true } };
		const planHandler = makeHandler();
		const executeHandler = makeHandler();

		const orch = new WorkflowOrchestrator({
			config,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: {
				...makeAllHandlers(),
				plan: planHandler,
				execute: executeHandler,
			},
		});

		await orch.run("test");

		expect(planHandler).toHaveBeenCalledTimes(2);
		expect(executeHandler).toHaveBeenCalledTimes(1);
		expect(mocks.messaging.requestApproval).toHaveBeenCalledTimes(2);
		expect(state.runs.list()[0].status).toBe("completed");

		state.close();
	});

	it("persists awaiting_approval and approval_requested before waiting for response", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();
		let statusWhenApprovalRequested: string | undefined;
		let approvalRequestedSnapshot:
			| { eventType: string; userResponse: string | null; respondedAt: string | null }
			| undefined;

		const approvedResponse: ApprovalResponse = {
			decision: "approved",
			feedback: null,
			respondedAt: new Date().toISOString(),
			channel: "tui",
		};

		vi.mocked(mocks.messaging.requestApproval).mockImplementation(async () => {
			const run = state.runs.list()[0];
			if (!run) {
				throw new Error("Expected run to exist when approval is requested");
			}
			statusWhenApprovalRequested = run.status;
			const approvalRequested = state.notifications
				.listByRun(run.id)
				.find((entry) => entry.eventType === "approval_requested");
			if (approvalRequested) {
				approvalRequestedSnapshot = {
					eventType: approvalRequested.eventType,
					userResponse: approvalRequested.userResponse,
					respondedAt: approvalRequested.respondedAt,
				};
			}
			return approvedResponse;
		});

		const config = { ...BASE_CONFIG, approvalGates: { rfc: true, plan: false } };
		const orch = new WorkflowOrchestrator({
			config,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: makeAllHandlers(),
		});

		await orch.run("test");

		expect(statusWhenApprovalRequested).toBe("awaiting_approval");
		expect(approvalRequestedSnapshot).toEqual({
			eventType: "approval_requested",
			userResponse: null,
			respondedAt: null,
		});

		const run = state.runs.list()[0];
		const notifications = state.notifications.listByRun(run.id);
		const approvalRequested = notifications.find(
			(entry) => entry.eventType === "approval_requested",
		);
		const approvalResponse = notifications.find((entry) => entry.eventType === "approval_response");

		expect(approvalRequested?.userResponse).toBe("approved");
		expect(approvalRequested?.respondedAt).toBe(approvedResponse.respondedAt);
		expect(approvalResponse?.userResponse).toBe("approved");
		expect(
			JSON.parse(approvalResponse?.payload ?? "{}") as { decision?: string; phase?: string },
		).toEqual(expect.objectContaining({ decision: "approved", phase: "rfc-draft" }));

		state.close();
	});

	it("fires approval_pending and approval_resolved events", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();
		const events: string[] = [];

		const config = { ...BASE_CONFIG, approvalGates: { rfc: true, plan: false } };

		const orch = new WorkflowOrchestrator({
			config,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: makeAllHandlers(),
			onEvent: (e) => events.push(e.type),
		});

		await orch.run("test");

		expect(events).toContain("approval_pending");
		expect(events).toContain("approval_resolved");

		state.close();
	});

	it("continues to next phase when approval is granted", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks(); // default mock returns "approved"

		const config = { ...BASE_CONFIG, approvalGates: { rfc: true, plan: false } };
		const draftPolishHandler = makeHandler();

		const orch = new WorkflowOrchestrator({
			config,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: {
				...makeAllHandlers(),
				"draft-polish": draftPolishHandler,
			},
		});

		await orch.run("test");

		expect(draftPolishHandler).toHaveBeenCalledOnce();

		state.close();
	});
});

describe("emitEvent safety", () => {
	it("does not crash the orchestrator when onEvent throws", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: makeAllHandlers(),
			onEvent: () => {
				throw new Error("TUI crash");
			},
		});

		// Should complete without propagating the TUI error
		await expect(orch.run("test")).resolves.toBeUndefined();

		state.close();
	});
});

describe("run() - conflicting incomplete run", () => {
	it("throws StateError when an incomplete run exists for a different task", async () => {
		const state = createInMemoryStateManager();
		const mocks = makeMocks();

		state.runs.create({
			taskDescription: "other task",
			slug: "other-task",
			status: "running",
			currentPhase: "rfc-draft",
			baseBranch: "main",
			workingBranch: null,
		});

		const orch = new WorkflowOrchestrator({
			config: BASE_CONFIG,
			runtime: MOCK_RUNTIME,
			state,
			...mocks,
			projectCwd: "/project",
			phases: makeAllHandlers(),
		});

		await expect(orch.run("new task")).rejects.toThrow(StateError);

		state.close();
	});
});
