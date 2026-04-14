import { spawn } from "node:child_process";
import { copyFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WorktreeError } from "../utils/errors";
import { logger } from "../utils/logger";
import type { WorktreeManager } from "./phases/types";

// --- Command runner abstraction ---

/**
 * Abstraction over child_process.spawn used by GitWorktreeManager.
 * Exposed so tests can inject a mock without mocking the entire node:child_process module.
 */
export type CommandRunner = (
	cmd: string,
	args: string[],
	cwd: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;

/**
 * Default CommandRunner implementation. Wraps spawn in a Promise, collects
 * stdout/stderr into string buffers, and resolves with the exit code.
 *
 * The `settled` guard prevents double-resolve in the unlikely case that both
 * the "error" and "close" events fire (e.g. when the child is killed).
 */
function spawnCommand(
	cmd: string,
	args: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	return new Promise((resolvePromise, rejectPromise) => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		let settled = false;

		const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

		// "error" fires when the binary cannot be launched (e.g. ENOENT, EACCES).
		child.once("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			rejectPromise(new WorktreeError(`Failed to launch '${cmd}': ${(error as Error).message}`));
		});

		// "close" fires after all I/O streams have been flushed and the process exits.
		child.once("close", (exitCode) => {
			if (settled) {
				return;
			}
			settled = true;
			resolvePromise({ stdout: stdout.join(""), stderr: stderr.join(""), exitCode });
		});
	});
}

// --- GitWorktreeManager ---

/**
 * Manages the full lifecycle of git worktrees used to isolate each slice's
 * agent from the main working tree and from other slices running in parallel.
 *
 * Layout convention:
 *   .trees/{slug}-{sliceIndex}/   ← worktree root (gitignored)
 *
 * Branch convention:
 *   task/{slug}-{sliceIndex}      ← unique branch per slice
 *
 * The orchestrator — not the agent — is responsible for calling create/setup
 * before a slice runs and remove after it completes. Agents only ever see
 * the worktree path handed to them via SliceExecutionContext.
 */
export class GitWorktreeManager implements WorktreeManager {
	private readonly projectCwd: string;
	/** Injectable for tests; defaults to the real spawn-based runner. */
	private readonly runCommand: CommandRunner;
	/** Injectable for tests; defaults to process.platform. */
	private readonly platform: NodeJS.Platform;

	constructor(
		projectCwd: string,
		runCommand: CommandRunner = spawnCommand,
		platform: NodeJS.Platform = process.platform,
	) {
		this.projectCwd = projectCwd;
		this.runCommand = runCommand;
		this.platform = platform;
	}

	/**
	 * Creates an isolated git worktree for a single slice.
	 *
	 * Runs: git worktree add -b task/{slug}-{sliceIndex} .trees/{slug}-{sliceIndex} {baseBranch}
	 *
	 * Returns the absolute path to the new worktree so the orchestrator can
	 * pass it to setup() and later hand it to the agent as its working directory.
	 *
	 * Throws WorktreeError if the branch already exists or if git fails for any
	 * other reason. Branch name collisions can occur when a previous run left a
	 * stale branch behind — callers should prune and retry or use a unique slug.
	 */
	async create(options: {
		runId: string;
		slug: string;
		sliceIndex: number;
		baseBranch: string;
	}): Promise<string> {
		const { slug, sliceIndex, baseBranch } = options;
		const branch = `task/${slug}-${sliceIndex}`;
		const relativeDir = `.trees/${slug}-${sliceIndex}`;
		const worktreePath = resolve(this.projectCwd, relativeDir);

		logger.info("Creating worktree", { branch, worktreePath, baseBranch });

		let result: { stdout: string; stderr: string; exitCode: number | null };
		try {
			result = await this.runCommand(
				"git",
				["worktree", "add", "-b", branch, relativeDir, baseBranch],
				this.projectCwd,
			);
		} catch (error) {
			// runCommand rejects only on launch failure (binary not found, permission denied).
			throw new WorktreeError(`Failed to create worktree '${worktreePath}': ${toMessage(error)}`, {
				path: worktreePath,
				branch,
				baseBranch,
			});
		}

		if (result.exitCode !== 0) {
			throw new WorktreeError(
				`Failed to create worktree '${worktreePath}' on branch '${branch}': ${result.stderr.trim()}`,
				{ path: worktreePath, branch, baseBranch },
			);
		}

		logger.debug("Worktree created", { worktreePath });
		return worktreePath;
	}

	/**
	 * Prepares a newly created worktree so the agent can run immediately.
	 *
	 * Two steps, in order:
	 *   1. Dependencies — copies node_modules using an APFS clone on macOS
	 *      (near-instant, copy-on-write) or runs npm install as a fallback.
	 *   2. Env files — copies .env* files from the project root so the agent
	 *      sees the same runtime secrets as the main tree.
	 */
	async setup(worktreePath: string): Promise<void> {
		logger.info("Setting up worktree", { worktreePath });

		await this.setupDependencies(worktreePath);
		await this.copyEnvFiles(worktreePath);

		logger.debug("Worktree setup complete", { worktreePath });
	}

	/**
	 * Removes a worktree via `git worktree remove`.
	 *
	 * Never uses rm -rf — git's own removal is safer because it refuses to
	 * delete a worktree that still has uncommitted changes, giving the
	 * orchestrator a chance to surface the situation rather than silently
	 * destroying work.
	 */
	async remove(worktreePath: string): Promise<void> {
		logger.info("Removing worktree", { worktreePath });

		let result: { stdout: string; stderr: string; exitCode: number | null };
		try {
			result = await this.runCommand("git", ["worktree", "remove", worktreePath], this.projectCwd);
		} catch (error) {
			throw new WorktreeError(
				`Failed to remove worktree at '${worktreePath}': ${toMessage(error)}`,
				{ path: worktreePath },
			);
		}

		if (result.exitCode !== 0) {
			throw new WorktreeError(
				`Failed to remove worktree at '${worktreePath}': ${result.stderr.trim()}`,
				{ path: worktreePath },
			);
		}

		logger.debug("Worktree removed", { worktreePath });
	}

	/**
	 * Runs `git worktree prune` to clean up stale worktree metadata.
	 *
	 * Git keeps a lock file for each registered worktree under .git/worktrees/.
	 * If a previous run was interrupted before remove() could finish, these
	 * locks remain and block future `git worktree add` calls for the same path.
	 * Prune deletes stale entries whose directories no longer exist on disk.
	 *
	 * The orchestrator should call this as part of crash recovery before
	 * attempting to recreate worktrees for a resumed run.
	 */
	async prune(): Promise<void> {
		logger.info("Pruning stale worktrees");

		let result: { stdout: string; stderr: string; exitCode: number | null };
		try {
			result = await this.runCommand("git", ["worktree", "prune"], this.projectCwd);
		} catch (error) {
			throw new WorktreeError(`git worktree prune failed: ${toMessage(error)}`);
		}

		if (result.exitCode !== 0) {
			throw new WorktreeError(`git worktree prune failed: ${result.stderr.trim()}`);
		}

		logger.debug("Worktree prune complete");
	}

	/**
	 * Installs dependencies into the worktree.
	 *
	 * Strategy:
	 *   - If no node_modules exists in the project root, skip entirely. The
	 *     worktree may not need dependencies (e.g. docs-only slices).
	 *   - On macOS with APFS: clone node_modules using `cp -cR` which triggers
	 *     copy-on-write at the filesystem level — the directory appears
	 *     instantly and only modified files consume additional disk space.
	 *   - On other platforms (or if the APFS clone fails): fall back to a
	 *     standard `npm install` inside the worktree.
	 */
	private async setupDependencies(worktreePath: string): Promise<void> {
		const srcModules = join(this.projectCwd, "node_modules");
		const destModules = join(worktreePath, "node_modules");

		try {
			await stat(srcModules);
		} catch {
			logger.debug("Skipping dependency setup — no node_modules in project root", { worktreePath });
			return;
		}

		if (this.platform === "darwin") {
			// -c enables APFS copy-on-write cloning; -R copies recursively.
			const result = await this.runCommand("cp", ["-cR", srcModules, destModules], worktreePath);
			if (result.exitCode === 0) {
				return;
			}
			logger.warn("APFS copy-on-write clone failed, falling back to npm install", {
				worktreePath,
				stderr: result.stderr.trim(),
			});
		}

		await this.npmInstall(worktreePath);
	}

	private async npmInstall(worktreePath: string): Promise<void> {
		logger.debug("Running npm install", { worktreePath });

		let result: { stdout: string; stderr: string; exitCode: number | null };
		try {
			result = await this.runCommand("npm", ["install"], worktreePath);
		} catch (error) {
			throw new WorktreeError(`npm install failed in worktree: ${toMessage(error)}`, {
				path: worktreePath,
			});
		}

		if (result.exitCode !== 0) {
			throw new WorktreeError(`npm install failed in worktree: ${result.stderr.trim()}`, {
				path: worktreePath,
			});
		}
	}

	/**
	 * Copies .env* files from the project root into the worktree.
	 *
	 * These files are gitignored in the main tree and therefore absent from the
	 * freshly checked-out worktree. Without them the agent's process would
	 * start with missing API keys or configuration.
	 *
	 * .env.example is skipped — it's committed to git and already present in
	 * the worktree, and it contains no real secrets.
	 */
	private async copyEnvFiles(worktreePath: string): Promise<void> {
		const entries = await readdir(this.projectCwd);
		const envFiles = entries.filter((name) => name.startsWith(".env") && name !== ".env.example");

		await Promise.all(
			envFiles.map((name) => copyFile(join(this.projectCwd, name), join(worktreePath, name))),
		);

		if (envFiles.length > 0) {
			logger.debug("Copied env files", { count: envFiles.length, worktreePath });
		}
	}
}

// --- Factory ---

export function createGitWorktreeManager(projectCwd: string): GitWorktreeManager {
	return new GitWorktreeManager(projectCwd);
}

// --- Utilities ---

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
