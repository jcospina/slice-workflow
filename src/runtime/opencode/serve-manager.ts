import { type ChildProcess, spawn } from "node:child_process";
import { RuntimeError } from "../../utils/errors";

export const OPENCODE_SERVER_BASE_URL = "http://127.0.0.1:4096";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_STARTUP_POLL_INTERVAL_MS = 250;
const DEFAULT_STOP_TIMEOUT_MS = 3_000;
const MAX_LOG_BUFFER_LENGTH = 4_000;

export interface OpenCodeServeManager {
	ensureServer(options: { cwd: string }): Promise<void>;
	stopServer(): Promise<void>;
}

export interface LocalOpenCodeServeManagerConfig {
	command?: string;
	baseUrl?: string;
	startupTimeoutMs?: number;
	startupPollIntervalMs?: number;
	stopTimeoutMs?: number;
}

interface LocalOpenCodeServeManagerDependencies {
	spawnProcess?: typeof spawn;
	probeServer?: (options: { cwd: string }) => Promise<void>;
	wait?: (durationMs: number) => Promise<void>;
	now?: () => number;
}

export class LocalOpenCodeServeManager implements OpenCodeServeManager {
	private readonly command: string;
	private readonly startupTimeoutMs: number;
	private readonly startupPollIntervalMs: number;
	private readonly stopTimeoutMs: number;
	private readonly spawnProcess: typeof spawn;
	private readonly probeServer: (options: { cwd: string }) => Promise<void>;
	private readonly wait: (durationMs: number) => Promise<void>;
	private readonly now: () => number;

	private serverProcess: ChildProcess | null = null;
	private ensureServerPromise: Promise<void> | null = null;
	private startupError: RuntimeError | null = null;
	private stdoutBuffer = "";
	private stderrBuffer = "";

	constructor(
		config: LocalOpenCodeServeManagerConfig = {},
		dependencies: LocalOpenCodeServeManagerDependencies = {},
	) {
		this.command = config.command ?? "opencode";
		this.startupTimeoutMs = config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
		this.startupPollIntervalMs = config.startupPollIntervalMs ?? DEFAULT_STARTUP_POLL_INTERVAL_MS;
		this.stopTimeoutMs = config.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
		this.spawnProcess = dependencies.spawnProcess ?? spawn;
		this.probeServer =
			dependencies.probeServer ??
			((options) =>
				probeOpenCodeServer({ baseUrl: config.baseUrl ?? OPENCODE_SERVER_BASE_URL, ...options }));
		this.wait =
			dependencies.wait ??
			((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
		this.now = dependencies.now ?? Date.now;
	}

	async ensureServer(options: { cwd: string }): Promise<void> {
		if (await this.isServerReady(options.cwd)) {
			return;
		}

		if (this.ensureServerPromise) {
			await this.ensureServerPromise;
			return;
		}

		this.ensureServerPromise = this.startServer(options.cwd);

		try {
			await this.ensureServerPromise;
		} finally {
			this.ensureServerPromise = null;
		}
	}

	async stopServer(): Promise<void> {
		const processToStop = this.serverProcess;

		if (!isProcessAlive(processToStop)) {
			this.serverProcess = null;
			return;
		}

		await terminateProcess(processToStop, this.stopTimeoutMs, this.wait);

		if (this.serverProcess === processToStop) {
			this.serverProcess = null;
		}
	}

	private async startServer(cwd: string): Promise<void> {
		if (!isProcessAlive(this.serverProcess)) {
			this.launchServer(cwd);
		}

		await this.waitForServerReadiness(cwd);
	}

	private launchServer(cwd: string): void {
		this.startupError = null;
		this.stdoutBuffer = "";
		this.stderrBuffer = "";
		let child: ChildProcess;

		try {
			child = this.spawnProcess(this.command, ["serve"], {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			const launchError = error as NodeJS.ErrnoException;
			this.startupError = new RuntimeError(buildLaunchFailureMessage(launchError, this.command), {
				provider: "opencode",
				method: "run",
				command: this.command,
				cwd,
				code: launchError.code,
				cause: error,
			});
			this.serverProcess = null;
			return;
		}

		this.serverProcess = child;

		child.stdout?.on("data", (chunk: Buffer | string) => {
			this.stdoutBuffer = appendToBuffer(this.stdoutBuffer, chunk.toString());
		});

		child.stderr?.on("data", (chunk: Buffer | string) => {
			this.stderrBuffer = appendToBuffer(this.stderrBuffer, chunk.toString());
		});

		child.once("error", (error) => {
			const launchError = error as NodeJS.ErrnoException;
			this.startupError = new RuntimeError(buildLaunchFailureMessage(launchError, this.command), {
				provider: "opencode",
				method: "run",
				command: this.command,
				cwd,
				code: launchError.code,
				cause: error,
			});
		});

		child.once("close", () => {
			if (this.serverProcess === child) {
				this.serverProcess = null;
			}
		});
	}

	private async waitForServerReadiness(cwd: string): Promise<void> {
		const deadline = this.now() + this.startupTimeoutMs;

		while (this.now() <= deadline) {
			if (this.startupError) {
				throw this.startupError;
			}

			if (await this.isServerReady(cwd)) {
				return;
			}

			if (!isProcessAlive(this.serverProcess)) {
				throw new RuntimeError(
					`OpenCode server process exited before becoming ready.${formatLogs(this.stdoutBuffer, this.stderrBuffer)}`,
					{
						provider: "opencode",
						method: "run",
						command: this.command,
						cwd,
					},
				);
			}

			await this.wait(this.startupPollIntervalMs);
		}

		throw new RuntimeError(
			`Timed out waiting for OpenCode server readiness after ${this.startupTimeoutMs}ms.${formatLogs(this.stdoutBuffer, this.stderrBuffer)}`,
			{
				provider: "opencode",
				method: "run",
				command: this.command,
				cwd,
				timeoutMs: this.startupTimeoutMs,
			},
		);
	}

	private async isServerReady(cwd: string): Promise<boolean> {
		try {
			await this.probeServer({ cwd });
			return true;
		} catch {
			return false;
		}
	}
}

async function probeOpenCodeServer(options: { baseUrl: string; cwd: string }): Promise<void> {
	const url = new URL("/path", options.baseUrl);
	url.searchParams.set("directory", options.cwd);

	const response = await fetch(url, { method: "GET" });

	if (!response.ok) {
		throw new Error(`OpenCode server probe failed with status ${response.status}.`);
	}
}

async function terminateProcess(
	child: ChildProcess,
	timeoutMs: number,
	wait: (durationMs: number) => Promise<void>,
): Promise<void> {
	const waitForExit = new Promise<void>((resolve) => {
		if (!isProcessAlive(child)) {
			resolve();
			return;
		}

		const onExit = () => {
			child.off("error", onError);
			resolve();
		};
		const onError = () => {
			child.off("close", onExit);
			resolve();
		};

		child.once("close", onExit);
		child.once("error", onError);
	});

	child.kill("SIGTERM");
	await Promise.race([waitForExit, wait(timeoutMs)]);

	if (isProcessAlive(child)) {
		child.kill("SIGKILL");
		await Promise.race([waitForExit, wait(250)]);
	}
}

function isProcessAlive(process: ChildProcess | null | undefined): process is ChildProcess {
	return (
		process !== null &&
		process !== undefined &&
		process.exitCode === null &&
		process.signalCode === null
	);
}

function appendToBuffer(buffer: string, chunk: string): string {
	const next = `${buffer}${chunk}`;

	if (next.length <= MAX_LOG_BUFFER_LENGTH) {
		return next;
	}

	return next.slice(next.length - MAX_LOG_BUFFER_LENGTH);
}

function formatLogs(stdout: string, stderr: string): string {
	const chunks: string[] = [];
	const normalizedStderr = stderr.trim();
	const normalizedStdout = stdout.trim();

	if (normalizedStderr.length > 0) {
		chunks.push(`stderr: ${normalizedStderr}`);
	}

	if (normalizedStdout.length > 0) {
		chunks.push(`stdout: ${normalizedStdout}`);
	}

	if (chunks.length === 0) {
		return "";
	}

	return `\n${chunks.join("\n")}`;
}

function buildLaunchFailureMessage(error: NodeJS.ErrnoException, command: string): string {
	if (error.code === "ENOENT") {
		return `OpenCode CLI command '${command}' was not found. Install OpenCode, ensure '${command}' is available on PATH, and retry.`;
	}

	if (error.code === "EACCES") {
		return `OpenCode CLI command '${command}' is not executable. Check the configured command path and permissions, then retry.`;
	}

	return `Failed to launch OpenCode CLI command '${command}': ${error.message}`;
}
