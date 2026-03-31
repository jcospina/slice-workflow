import { describe, expect, it, vi } from "vitest";
import type { Provider } from "../config/types";
import type { UpdatePhaseRecord, UpdateSliceRecord } from "../state/types";
import { RuntimeError } from "../utils/errors";
import type {
	AgentInteractiveOptions,
	AgentRunOptions,
	AgentRunResult,
	AgentRuntime,
	ProgressEvent,
} from "./types";

// --- Test helpers ---

function makeResult(overrides?: Partial<AgentRunResult>): AgentRunResult {
	return {
		success: true,
		output: "Done.",
		sessionId: "sess-abc123",
		costUsd: 0.42,
		durationMs: 12000,
		...overrides,
	};
}

function defaultProgressSequence(): ProgressEvent[] {
	return [
		{ type: "agent_start" },
		{ type: "tool_start", tool: "read_file" },
		{ type: "tool_end", tool: "read_file" },
		{ type: "text_output", text: "Working on it..." },
		{ type: "cost_update", totalCostUsd: 0.21 },
		{ type: "cost_update", totalCostUsd: 0.42 },
		{ type: "turn_complete", turnNumber: 1 },
	];
}

interface MockRuntimeOverrides {
	provider?: Provider;
	runResult?: Partial<AgentRunResult>;
	interactiveResult?: Partial<AgentRunResult>;
	progressEvents?: ProgressEvent[];
	runImplementation?: (options: AgentRunOptions) => Promise<AgentRunResult>;
	interactiveImplementation?: (options: AgentInteractiveOptions) => Promise<AgentRunResult>;
}

function createMockRuntime(overrides: MockRuntimeOverrides = {}): AgentRuntime {
	const provider: Provider = overrides.provider ?? "claude-code";
	const events = overrides.progressEvents ?? defaultProgressSequence();

	const run = overrides.runImplementation
		? vi.fn(overrides.runImplementation)
		: vi.fn((options: AgentRunOptions) => {
				if (options.onProgress) {
					for (const event of events) {
						options.onProgress(event);
					}
				}
				return Promise.resolve(makeResult(overrides.runResult));
			});

	const runInteractive = overrides.interactiveImplementation
		? vi.fn(overrides.interactiveImplementation)
		: vi.fn((_options: AgentInteractiveOptions) => {
				return Promise.resolve(makeResult(overrides.interactiveResult));
			});

	return { provider, run, runInteractive };
}

// --- Tests ---

describe("AgentRuntime contract", () => {
	describe("contract conformance", () => {
		it("run() result has all required fields with correct types", async () => {
			const runtime = createMockRuntime();
			const result = await runtime.run({ prompt: "test", cwd: "/tmp" });

			expect(typeof result.success).toBe("boolean");
			expect(typeof result.output).toBe("string");
			expect(typeof result.sessionId).toBe("string");
			expect(typeof result.costUsd).toBe("number");
			expect(typeof result.durationMs).toBe("number");
		});

		it("successful result does not contain error field", async () => {
			const runtime = createMockRuntime({ runResult: { success: true } });
			const result = await runtime.run({ prompt: "test", cwd: "/tmp" });
			expect(result.success).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it("failed result includes non-empty error string", async () => {
			const runtime = createMockRuntime({
				runResult: { success: false, error: "Token limit exceeded" },
			});
			const result = await runtime.run({ prompt: "test", cwd: "/tmp" });
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
			expect(typeof result.error).toBe("string");
			expect(result.error?.length).toBeGreaterThan(0);
		});

		it("sessionId is a non-empty string", async () => {
			const runtime = createMockRuntime();
			const result = await runtime.run({ prompt: "test", cwd: "/tmp" });
			expect(result.sessionId.length).toBeGreaterThan(0);
		});

		it("costUsd is non-negative", async () => {
			const runtime = createMockRuntime();
			const result = await runtime.run({ prompt: "test", cwd: "/tmp" });
			expect(result.costUsd).toBeGreaterThanOrEqual(0);
		});

		it("durationMs is a non-negative integer", async () => {
			const runtime = createMockRuntime();
			const result = await runtime.run({ prompt: "test", cwd: "/tmp" });
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
			expect(Number.isInteger(result.durationMs)).toBe(true);
		});

		it("provider matches expected value", () => {
			const runtime = createMockRuntime({ provider: "opencode" });
			expect(runtime.provider).toBe("opencode");
		});

		it("runInteractive returns same result shape as run", async () => {
			const runtime = createMockRuntime();
			const result = await runtime.runInteractive({ cwd: "/tmp" });

			expect(typeof result.success).toBe("boolean");
			expect(typeof result.output).toBe("string");
			expect(typeof result.sessionId).toBe("string");
			expect(typeof result.costUsd).toBe("number");
			expect(typeof result.durationMs).toBe("number");
		});
	});

	describe("options forwarding", () => {
		it("run passes prompt and cwd to implementation", async () => {
			const runtime = createMockRuntime();
			await runtime.run({ prompt: "Implement auth", cwd: "/workspace" });
			expect(runtime.run).toHaveBeenCalledWith(
				expect.objectContaining({ prompt: "Implement auth", cwd: "/workspace" }),
			);
		});

		it("optional fields omitted without crash", async () => {
			const runtime = createMockRuntime();
			const result = await runtime.run({ prompt: "test", cwd: "/tmp" });
			expect(result.success).toBe(true);
		});

		it("runInteractive accepts prompt as optional", async () => {
			const runtime = createMockRuntime();
			const result = await runtime.runInteractive({ cwd: "/tmp" });
			expect(result.success).toBe(true);
		});
	});

	describe("progress streaming", () => {
		it("onProgress receives all events in order", async () => {
			const received: ProgressEvent[] = [];
			const runtime = createMockRuntime();
			await runtime.run({
				prompt: "test",
				cwd: "/tmp",
				onProgress: (e) => received.push(e),
			});
			expect(received).toHaveLength(defaultProgressSequence().length);
			expect(received).toEqual(defaultProgressSequence());
		});

		it("first event is agent_start", async () => {
			const received: ProgressEvent[] = [];
			const runtime = createMockRuntime();
			await runtime.run({
				prompt: "test",
				cwd: "/tmp",
				onProgress: (e) => received.push(e),
			});
			expect(received[0]).toEqual({ type: "agent_start" });
		});

		it("every tool_start has a matching tool_end for same tool", async () => {
			const received: ProgressEvent[] = [];
			const runtime = createMockRuntime();
			await runtime.run({
				prompt: "test",
				cwd: "/tmp",
				onProgress: (e) => received.push(e),
			});

			const starts = received.filter(
				(e): e is Extract<ProgressEvent, { type: "tool_start" }> => e.type === "tool_start",
			);

			for (const start of starts) {
				const startIdx = received.indexOf(start);
				const endIdx = received.findIndex(
					(e, i) => i > startIdx && e.type === "tool_end" && "tool" in e && e.tool === start.tool,
				);
				expect(endIdx).toBeGreaterThan(startIdx);
			}
		});

		it("cost_update totalCostUsd is monotonically non-decreasing", async () => {
			const received: ProgressEvent[] = [];
			const runtime = createMockRuntime();
			await runtime.run({
				prompt: "test",
				cwd: "/tmp",
				onProgress: (e) => received.push(e),
			});

			const costs = received
				.filter(
					(e): e is Extract<ProgressEvent, { type: "cost_update" }> => e.type === "cost_update",
				)
				.map((e) => e.totalCostUsd);

			for (let i = 1; i < costs.length; i++) {
				expect(costs[i]).toBeGreaterThanOrEqual(costs[i - 1]);
			}
		});

		it("turn_complete turnNumber increments", async () => {
			const events: ProgressEvent[] = [
				{ type: "agent_start" },
				{ type: "turn_complete", turnNumber: 1 },
				{ type: "turn_complete", turnNumber: 2 },
				{ type: "turn_complete", turnNumber: 3 },
			];
			const received: ProgressEvent[] = [];
			const runtime = createMockRuntime({ progressEvents: events });
			await runtime.run({
				prompt: "test",
				cwd: "/tmp",
				onProgress: (e) => received.push(e),
			});

			const turns = received
				.filter(
					(e): e is Extract<ProgressEvent, { type: "turn_complete" }> => e.type === "turn_complete",
				)
				.map((e) => e.turnNumber);

			for (let i = 1; i < turns.length; i++) {
				expect(turns[i]).toBe(turns[i - 1] + 1);
			}
		});

		it("does not crash when onProgress is omitted", async () => {
			const runtime = createMockRuntime();
			await expect(runtime.run({ prompt: "test", cwd: "/tmp" })).resolves.toBeDefined();
		});

		it("error event has non-empty message", async () => {
			const events: ProgressEvent[] = [
				{ type: "agent_start" },
				{ type: "error", message: "Something went wrong" },
			];
			const received: ProgressEvent[] = [];
			const runtime = createMockRuntime({ progressEvents: events });
			await runtime.run({
				prompt: "test",
				cwd: "/tmp",
				onProgress: (e) => received.push(e),
			});

			const errorEvent = received.find(
				(e): e is Extract<ProgressEvent, { type: "error" }> => e.type === "error",
			);
			expect(errorEvent).toBeDefined();
			expect(errorEvent?.message.length).toBeGreaterThan(0);
		});
	});

	describe("error scenarios", () => {
		it("run rejects with RuntimeError on adapter failure", async () => {
			const runtime = createMockRuntime({
				runImplementation: () =>
					Promise.reject(new RuntimeError("Process exited with code 1", { phase: "execute" })),
			});
			await expect(runtime.run({ prompt: "test", cwd: "/tmp" })).rejects.toThrow(RuntimeError);
			await expect(runtime.run({ prompt: "test", cwd: "/tmp" })).rejects.toThrow(
				"Process exited with code 1",
			);
		});

		it("failed result still has valid sessionId, costUsd, durationMs", async () => {
			const runtime = createMockRuntime({
				runResult: {
					success: false,
					error: "Out of context",
					sessionId: "sess-fail-001",
					costUsd: 0.15,
					durationMs: 5000,
				},
			});
			const result = await runtime.run({ prompt: "test", cwd: "/tmp" });
			expect(result.success).toBe(false);
			expect(result.sessionId).toBe("sess-fail-001");
			expect(result.costUsd).toBe(0.15);
			expect(result.durationMs).toBe(5000);
		});

		it("onProgress receives error event on graceful failure", async () => {
			const errorEvents: ProgressEvent[] = [
				{ type: "agent_start" },
				{ type: "error", message: "Context window exceeded" },
			];
			const received: ProgressEvent[] = [];
			const runtime = createMockRuntime({
				progressEvents: errorEvents,
				runResult: { success: false, error: "Context window exceeded" },
			});
			await runtime.run({
				prompt: "test",
				cwd: "/tmp",
				onProgress: (e) => received.push(e),
			});

			const errorEvent = received.find(
				(e): e is Extract<ProgressEvent, { type: "error" }> => e.type === "error",
			);
			expect(errorEvent).toBeDefined();
			expect(errorEvent?.message).toBe("Context window exceeded");
		});

		it("concurrent runs are independent", async () => {
			const runtime = createMockRuntime();
			const [r1, r2] = await Promise.all([
				runtime.run({ prompt: "task-a", cwd: "/a" }),
				runtime.run({ prompt: "task-b", cwd: "/b" }),
			]);
			expect(r1.success).toBe(true);
			expect(r2.success).toBe(true);
			expect(runtime.run).toHaveBeenCalledTimes(2);
		});
	});

	describe("result-to-state mapping", () => {
		it("successful result maps to UpdatePhaseRecord with completed status", async () => {
			const runtime = createMockRuntime({
				runResult: { sessionId: "sess-42", costUsd: 1.5, durationMs: 30000 },
			});
			const result = await runtime.run({ prompt: "test", cwd: "/tmp" });

			const phaseUpdate: UpdatePhaseRecord = {
				status: result.success ? "completed" : "failed",
				agentSessionId: result.sessionId,
				costUsd: result.costUsd,
				durationMs: result.durationMs,
				error: result.error ?? null,
				endedAt: new Date().toISOString(),
			};

			expect(phaseUpdate.status).toBe("completed");
			expect(phaseUpdate.agentSessionId).toBe("sess-42");
			expect(phaseUpdate.costUsd).toBe(1.5);
			expect(phaseUpdate.durationMs).toBe(30000);
			expect(phaseUpdate.error).toBeNull();
		});

		it("failed result maps to failed status with error string", async () => {
			const runtime = createMockRuntime({
				runResult: { success: false, error: "Timeout", costUsd: 0.8, durationMs: 120000 },
			});
			const result = await runtime.run({ prompt: "test", cwd: "/tmp" });

			const phaseUpdate: UpdatePhaseRecord = {
				status: result.success ? "completed" : "failed",
				agentSessionId: result.sessionId,
				costUsd: result.costUsd,
				durationMs: result.durationMs,
				error: result.error ?? null,
			};

			expect(phaseUpdate.status).toBe("failed");
			expect(phaseUpdate.error).toBe("Timeout");
			expect(phaseUpdate.costUsd).toBe(0.8);
			expect(phaseUpdate.durationMs).toBe(120000);
		});

		it("sessionId maps to agentSessionId for slice records", async () => {
			const runtime = createMockRuntime({
				runResult: { sessionId: "sess-slice-7", costUsd: 2.0, durationMs: 60000 },
			});
			const result = await runtime.run({ prompt: "test", cwd: "/tmp" });

			const sliceUpdate: UpdateSliceRecord = {
				status: result.success ? "completed" : "failed",
				agentSessionId: result.sessionId,
				costUsd: result.costUsd,
				durationMs: result.durationMs,
				error: result.error ?? null,
			};

			expect(sliceUpdate.agentSessionId).toBe("sess-slice-7");
			expect(sliceUpdate.costUsd).toBe(2.0);
		});

		it("zero-cost result maps to 0, not null", async () => {
			const runtime = createMockRuntime({ runResult: { costUsd: 0, durationMs: 0 } });
			const result = await runtime.run({ prompt: "test", cwd: "/tmp" });

			expect(result.costUsd).toBe(0);
			expect(result.durationMs).toBe(0);
			expect(result.costUsd).not.toBeNull();
			expect(result.durationMs).not.toBeNull();
		});

		it("phase and slice update types accept the same mapping", async () => {
			const runtime = createMockRuntime();
			const result = await runtime.run({ prompt: "test", cwd: "/tmp" });

			const mapping = {
				status: result.success ? ("completed" as const) : ("failed" as const),
				agentSessionId: result.sessionId,
				costUsd: result.costUsd,
				durationMs: result.durationMs,
				error: result.error ?? null,
			};

			const phaseUpdate: UpdatePhaseRecord = mapping;
			const sliceUpdate: UpdateSliceRecord = mapping;

			expect(phaseUpdate.agentSessionId).toBe(sliceUpdate.agentSessionId);
			expect(phaseUpdate.costUsd).toBe(sliceUpdate.costUsd);
		});
	});

	describe("edge cases and failure modes", () => {
		it("SDK process crash returns result with error, not unhandled rejection", async () => {
			const received: ProgressEvent[] = [];
			const runtime = createMockRuntime({
				runImplementation: (options) => {
					options.onProgress?.({ type: "agent_start" });
					options.onProgress?.({ type: "tool_start", tool: "write_file" });
					options.onProgress?.({ type: "error", message: "SIGKILL: agent process killed" });
					return Promise.resolve(
						makeResult({
							success: false,
							error: "SIGKILL: agent process killed",
							costUsd: 0.03,
							durationMs: 1500,
						}),
					);
				},
			});

			const result = await runtime.run({
				prompt: "test",
				cwd: "/tmp",
				onProgress: (e) => received.push(e),
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("SIGKILL");
			// Cost and session still captured even on crash
			expect(result.costUsd).toBeGreaterThanOrEqual(0);
			expect(result.sessionId.length).toBeGreaterThan(0);
			// tool_start without tool_end is expected on crash — verify events were emitted
			const starts = received.filter((e) => e.type === "tool_start");
			const ends = received.filter((e) => e.type === "tool_end");
			expect(starts.length).toBeGreaterThan(ends.length);
		});

		it("cancellation mid-run rejects with RuntimeError and partial cost", async () => {
			const received: ProgressEvent[] = [];
			const runtime = createMockRuntime({
				runImplementation: (options) => {
					options.onProgress?.({ type: "agent_start" });
					options.onProgress?.({ type: "tool_start", tool: "read_file" });
					options.onProgress?.({ type: "tool_end", tool: "read_file" });
					options.onProgress?.({ type: "cost_update", totalCostUsd: 0.05 });
					// Simulate cancellation — adapter rejects mid-execution
					return Promise.reject(new RuntimeError("Run cancelled by user", { phase: "execute" }));
				},
			});

			await expect(
				runtime.run({
					prompt: "test",
					cwd: "/tmp",
					onProgress: (e) => received.push(e),
				}),
			).rejects.toThrow("Run cancelled by user");

			// Progress events emitted before cancellation are still captured
			expect(received).toHaveLength(4);
			const lastCost = received.find(
				(e): e is Extract<ProgressEvent, { type: "cost_update" }> => e.type === "cost_update",
			);
			expect(lastCost?.totalCostUsd).toBe(0.05);
		});

		it("SDK connection failure rejects before any progress events", async () => {
			const received: ProgressEvent[] = [];
			const runtime = createMockRuntime({
				runImplementation: () =>
					Promise.reject(
						new RuntimeError("Failed to connect to Claude Code SDK", {
							phase: "rfc-draft",
						}),
					),
			});

			await expect(
				runtime.run({
					prompt: "test",
					cwd: "/tmp",
					onProgress: (e) => received.push(e),
				}),
			).rejects.toThrow("Failed to connect to Claude Code SDK");

			// No progress events should have been emitted
			expect(received).toHaveLength(0);
		});

		it("SDK timeout produces result with partial output", async () => {
			const runtime = createMockRuntime({
				runImplementation: (options) => {
					options.onProgress?.({ type: "agent_start" });
					options.onProgress?.({ type: "text_output", text: "Started implementing..." });
					options.onProgress?.({ type: "cost_update", totalCostUsd: 0.5 });
					options.onProgress?.({ type: "error", message: "Operation timed out after 300s" });
					return Promise.resolve(
						makeResult({
							success: false,
							output: "Started implementing...",
							error: "Operation timed out after 300s",
							costUsd: 0.5,
							durationMs: 300000,
						}),
					);
				},
			});

			const result = await runtime.run({ prompt: "test", cwd: "/tmp" });

			expect(result.success).toBe(false);
			expect(result.error).toContain("timed out");
			// Partial output is preserved
			expect(result.output.length).toBeGreaterThan(0);
			// Cost is still tracked
			expect(result.costUsd).toBe(0.5);
			expect(result.durationMs).toBe(300000);
		});

		it("onProgress throwing does not swallow the run result", async () => {
			let callCount = 0;
			const runtime = createMockRuntime({
				runImplementation: (options) => {
					// Adapter calls onProgress; consumer throws on second call
					options.onProgress?.({ type: "agent_start" });
					try {
						options.onProgress?.({ type: "text_output", text: "hello" });
					} catch {
						// Adapter should catch and continue
					}
					return Promise.resolve(makeResult());
				},
			});

			const result = await runtime.run({
				prompt: "test",
				cwd: "/tmp",
				onProgress: () => {
					callCount++;
					if (callCount === 2) {
						throw new Error("TUI render crashed");
					}
				},
			});

			// Run should still complete despite onProgress error
			expect(result.success).toBe(true);
			expect(result.output).toBe("Done.");
		});

		it("empty output on success is valid but detectable", async () => {
			const runtime = createMockRuntime({
				runResult: { success: true, output: "" },
			});
			const result = await runtime.run({ prompt: "test", cwd: "/tmp" });

			expect(result.success).toBe(true);
			expect(result.output).toBe("");
			expect(typeof result.output).toBe("string");
		});

		it("very large output does not corrupt result shape", async () => {
			const largeOutput = "x".repeat(1_000_000);
			const runtime = createMockRuntime({
				runResult: { output: largeOutput },
			});
			const result = await runtime.run({ prompt: "test", cwd: "/tmp" });

			expect(result.output).toHaveLength(1_000_000);
			expect(typeof result.sessionId).toBe("string");
			expect(typeof result.costUsd).toBe("number");
		});

		it("rapid sequential runs do not leak state between calls", async () => {
			let callIndex = 0;
			const runtime = createMockRuntime({
				runImplementation: (options) => {
					callIndex++;
					const current = callIndex;
					options.onProgress?.({ type: "agent_start" });
					options.onProgress?.({ type: "cost_update", totalCostUsd: current * 0.1 });
					return Promise.resolve(
						makeResult({
							sessionId: `sess-${current}`,
							costUsd: current * 0.1,
						}),
					);
				},
			});

			const results: AgentRunResult[] = [];
			for (let i = 0; i < 5; i++) {
				results.push(await runtime.run({ prompt: `task-${i}`, cwd: "/tmp" }));
			}

			// Each run got a unique session and incrementing cost
			const sessionIds = results.map((r) => r.sessionId);
			expect(new Set(sessionIds).size).toBe(5);
			for (let i = 1; i < results.length; i++) {
				expect(results[i].costUsd).toBeGreaterThan(results[i - 1].costUsd);
			}
		});

		it("interactive session crash returns result, not unhandled rejection", async () => {
			const runtime = createMockRuntime({
				interactiveImplementation: () =>
					Promise.resolve(
						makeResult({
							success: false,
							error: "Terminal session terminated unexpectedly",
							costUsd: 0.02,
							durationMs: 800,
						}),
					),
			});

			const result = await runtime.runInteractive({ cwd: "/tmp", prompt: "draft RFC" });

			expect(result.success).toBe(false);
			expect(result.error).toContain("terminated unexpectedly");
			expect(result.costUsd).toBe(0.02);
			expect(result.sessionId.length).toBeGreaterThan(0);
		});

		it("maxTurns exhaustion produces a graceful failure, not a crash", async () => {
			const runtime = createMockRuntime({
				runImplementation: (options) => {
					const turns = options.maxTurns ?? 10;
					for (let t = 1; t <= turns; t++) {
						options.onProgress?.({ type: "turn_complete", turnNumber: t });
					}
					options.onProgress?.({
						type: "error",
						message: `Max turns (${turns}) reached without completion`,
					});
					return Promise.resolve(
						makeResult({
							success: false,
							error: `Max turns (${turns}) reached without completion`,
							costUsd: turns * 0.05,
							durationMs: turns * 2000,
						}),
					);
				},
			});

			const received: ProgressEvent[] = [];
			const result = await runtime.run({
				prompt: "test",
				cwd: "/tmp",
				maxTurns: 3,
				onProgress: (e) => received.push(e),
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("Max turns (3)");

			const turns = received.filter((e) => e.type === "turn_complete");
			expect(turns).toHaveLength(3);

			const errorEvent = received.find((e) => e.type === "error");
			expect(errorEvent).toBeDefined();
		});

		it("run failure followed by successful retry produces independent results", async () => {
			let attempt = 0;
			const runtime = createMockRuntime({
				runImplementation: (options) => {
					attempt++;
					options.onProgress?.({ type: "agent_start" });
					if (attempt === 1) {
						options.onProgress?.({ type: "error", message: "Transient API error" });
						return Promise.resolve(
							makeResult({
								success: false,
								error: "Transient API error",
								sessionId: "sess-fail",
								costUsd: 0.01,
								durationMs: 500,
							}),
						);
					}
					return Promise.resolve(
						makeResult({
							sessionId: "sess-retry-ok",
							costUsd: 0.3,
							durationMs: 15000,
						}),
					);
				},
			});

			const r1 = await runtime.run({ prompt: "test", cwd: "/tmp" });
			const r2 = await runtime.run({ prompt: "test", cwd: "/tmp" });

			expect(r1.success).toBe(false);
			expect(r1.sessionId).toBe("sess-fail");
			expect(r2.success).toBe(true);
			expect(r2.sessionId).toBe("sess-retry-ok");
			// Costs are independent
			expect(r2.costUsd).toBeGreaterThan(r1.costUsd);
		});
	});

	describe("provider variants", () => {
		it.each(["claude-code", "opencode"] as const)(
			"%s provider satisfies the contract",
			async (providerName) => {
				const runtime = createMockRuntime({ provider: providerName });
				expect(runtime.provider).toBe(providerName);

				const result = await runtime.run({ prompt: "test", cwd: "/tmp" });
				expect(result.success).toBe(true);
				expect(typeof result.sessionId).toBe("string");

				const interactiveResult = await runtime.runInteractive({ cwd: "/tmp" });
				expect(interactiveResult.success).toBe(true);
			},
		);
	});
});
