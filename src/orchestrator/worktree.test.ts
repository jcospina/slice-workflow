import { copyFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeError } from "../utils/errors";
import { type CommandRunner, GitWorktreeManager } from "./worktree";

vi.mock("node:fs/promises");

const mockStat = vi.mocked(stat);
const mockReaddir = vi.mocked(readdir);
const mockCopyFile = vi.mocked(copyFile);

const PROJECT_CWD = "/fake/project";
const WORKTREE_PATH = "/fake/worktree";

function makeRunner(
	override: Partial<{ exitCode: number; stderr: string; stdout: string }> = {},
): CommandRunner {
	return vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", ...override });
}

describe("GitWorktreeManager", () => {
	afterEach(() => {
		vi.resetAllMocks();
	});

	// --- create ---

	describe("create", () => {
		it("returns correct absolute worktree path on success", async () => {
			const runner = makeRunner();
			const manager = new GitWorktreeManager(PROJECT_CWD, runner);

			const result = await manager.create({
				runId: "run-1",
				slug: "my-slug",
				sliceIndex: 2,
				baseBranch: "main",
			});

			expect(result).toBe(resolve(PROJECT_CWD, ".trees/my-slug-2"));
		});

		it("passes correct git worktree add arguments", async () => {
			const runner = makeRunner();
			const manager = new GitWorktreeManager(PROJECT_CWD, runner);

			await manager.create({
				runId: "run-1",
				slug: "my-slug",
				sliceIndex: 2,
				baseBranch: "main",
			});

			expect(runner).toHaveBeenCalledWith(
				"git",
				["worktree", "add", "-b", "task/my-slug-2", ".trees/my-slug-2", "main"],
				PROJECT_CWD,
			);
		});

		it("throws WorktreeError with path context on non-zero exit", async () => {
			const runner = makeRunner({ exitCode: 128, stderr: "fatal: branch already exists" });
			const manager = new GitWorktreeManager(PROJECT_CWD, runner);

			await expect(
				manager.create({ runId: "run-1", slug: "dup", sliceIndex: 0, baseBranch: "main" }),
			).rejects.toSatisfy((err: unknown) => {
				expect(err).toBeInstanceOf(WorktreeError);
				const e = err as WorktreeError;
				expect(e.message).toContain("already exists");
				expect(e.context.path).toBe(resolve(PROJECT_CWD, ".trees/dup-0"));
				return true;
			});
		});

		it("throws WorktreeError when runCommand rejects (launch failure)", async () => {
			const runner = vi.fn().mockRejectedValue(new Error("ENOENT: git not found"));
			const manager = new GitWorktreeManager(PROJECT_CWD, runner);

			const error = await manager
				.create({ runId: "run-1", slug: "test", sliceIndex: 0, baseBranch: "main" })
				.catch((e: unknown) => e);

			expect(error).toBeInstanceOf(WorktreeError);
			expect((error as WorktreeError).message).toContain("ENOENT");
		});
	});

	// --- remove ---

	describe("remove", () => {
		it("calls git worktree remove with the worktree path", async () => {
			const runner = makeRunner();
			const manager = new GitWorktreeManager(PROJECT_CWD, runner);

			await manager.remove(WORKTREE_PATH);

			expect(runner).toHaveBeenCalledWith(
				"git",
				["worktree", "remove", WORKTREE_PATH],
				PROJECT_CWD,
			);
		});

		it("throws WorktreeError with path context on non-zero exit", async () => {
			const runner = makeRunner({ exitCode: 1, stderr: "not a worktree" });
			const manager = new GitWorktreeManager(PROJECT_CWD, runner);

			const error = await manager.remove(WORKTREE_PATH).catch((e: unknown) => e);

			expect(error).toBeInstanceOf(WorktreeError);
			expect((error as WorktreeError).context.path).toBe(WORKTREE_PATH);
			expect((error as WorktreeError).message).toContain("not a worktree");
		});

		it("never calls runCommand with rm", async () => {
			const runner = makeRunner({ exitCode: 1, stderr: "error" });
			const manager = new GitWorktreeManager(PROJECT_CWD, runner);

			await manager.remove(WORKTREE_PATH).catch((_err: unknown) => {
				// intentional: testing that rm is never called regardless of outcome
			});

			const calls = vi.mocked(runner).mock.calls;
			expect(calls.every(([cmd]) => cmd !== "rm")).toBe(true);
		});
	});

	// --- prune ---

	describe("prune", () => {
		it("calls git worktree prune and resolves on success", async () => {
			const runner = makeRunner();
			const manager = new GitWorktreeManager(PROJECT_CWD, runner);

			await expect(manager.prune()).resolves.toBeUndefined();
			expect(runner).toHaveBeenCalledWith("git", ["worktree", "prune"], PROJECT_CWD);
		});

		it("throws WorktreeError on non-zero exit", async () => {
			const runner = makeRunner({ exitCode: 1, stderr: "lock file present" });
			const manager = new GitWorktreeManager(PROJECT_CWD, runner);

			const error = await manager.prune().catch((e: unknown) => e);

			expect(error).toBeInstanceOf(WorktreeError);
			expect((error as WorktreeError).message).toContain("lock file present");
		});
	});

	// --- setup ---

	describe("setup", () => {
		beforeEach(() => {
			// Default: no node_modules, no env files
			mockStat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
			mockReaddir.mockResolvedValue([] as never);
			mockCopyFile.mockResolvedValue(undefined);
		});

		it("skips dependency setup and env copy when node_modules absent and no env files", async () => {
			const runner = makeRunner();
			const manager = new GitWorktreeManager(PROJECT_CWD, runner);

			await expect(manager.setup(WORKTREE_PATH)).resolves.toBeUndefined();

			expect(runner).not.toHaveBeenCalled();
			expect(mockCopyFile).not.toHaveBeenCalled();
		});

		it("uses cp -cR on darwin when node_modules is present and does not call npm", async () => {
			mockStat.mockResolvedValue({} as never);

			const runner = makeRunner();
			const manager = new GitWorktreeManager(PROJECT_CWD, runner, "darwin");

			await manager.setup(WORKTREE_PATH);

			expect(runner).toHaveBeenCalledOnce();
			expect(runner).toHaveBeenCalledWith(
				"cp",
				["-cR", join(PROJECT_CWD, "node_modules"), join(WORKTREE_PATH, "node_modules")],
				WORKTREE_PATH,
			);
		});

		it("falls back to npm install when cp -cR fails on darwin", async () => {
			mockStat.mockResolvedValue({} as never);

			const runner = vi
				.fn()
				.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "cp: error" })
				.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

			const manager = new GitWorktreeManager(PROJECT_CWD, runner, "darwin");

			await manager.setup(WORKTREE_PATH);

			expect(runner).toHaveBeenCalledTimes(2);
			expect(runner).toHaveBeenNthCalledWith(1, "cp", expect.anything(), WORKTREE_PATH);
			expect(runner).toHaveBeenNthCalledWith(2, "npm", ["install"], WORKTREE_PATH);
		});

		it("runs npm install on linux when node_modules is present and does not call cp", async () => {
			mockStat.mockResolvedValue({} as never);

			const runner = makeRunner();
			const manager = new GitWorktreeManager(PROJECT_CWD, runner, "linux");

			await manager.setup(WORKTREE_PATH);

			expect(runner).toHaveBeenCalledOnce();
			expect(runner).toHaveBeenCalledWith("npm", ["install"], WORKTREE_PATH);
		});

		it("throws WorktreeError when npm install fails", async () => {
			mockStat.mockResolvedValue({} as never);

			const runner = makeRunner({ exitCode: 1, stderr: "npm ERR! code E404" });
			const manager = new GitWorktreeManager(PROJECT_CWD, runner, "linux");

			const error = await manager.setup(WORKTREE_PATH).catch((e: unknown) => e);

			expect(error).toBeInstanceOf(WorktreeError);
			expect((error as WorktreeError).message).toContain("npm ERR! code E404");
			expect((error as WorktreeError).context.path).toBe(WORKTREE_PATH);
		});

		it("copies .env and .env.local but not .env.example", async () => {
			mockReaddir.mockResolvedValue([".env", ".env.local", ".env.example"] as never);

			const runner = makeRunner();
			const manager = new GitWorktreeManager(PROJECT_CWD, runner);

			await manager.setup(WORKTREE_PATH);

			expect(mockCopyFile).toHaveBeenCalledWith(
				join(PROJECT_CWD, ".env"),
				join(WORKTREE_PATH, ".env"),
			);
			expect(mockCopyFile).toHaveBeenCalledWith(
				join(PROJECT_CWD, ".env.local"),
				join(WORKTREE_PATH, ".env.local"),
			);
			expect(mockCopyFile).not.toHaveBeenCalledWith(
				expect.stringContaining(".env.example"),
				expect.anything(),
			);
		});

		it("does not throw and makes no copyFile call when no env files exist", async () => {
			mockReaddir.mockResolvedValue([] as never);

			const runner = makeRunner();
			const manager = new GitWorktreeManager(PROJECT_CWD, runner);

			await expect(manager.setup(WORKTREE_PATH)).resolves.toBeUndefined();
			expect(mockCopyFile).not.toHaveBeenCalled();
		});

		it("copies env files alongside APFS node_modules clone on darwin", async () => {
			mockStat.mockResolvedValue({} as never);
			mockReaddir.mockResolvedValue([".env"] as never);

			const runner = makeRunner();
			const manager = new GitWorktreeManager(PROJECT_CWD, runner, "darwin");

			await manager.setup(WORKTREE_PATH);

			expect(runner).toHaveBeenCalledWith("cp", expect.anything(), WORKTREE_PATH);
			expect(mockCopyFile).toHaveBeenCalledWith(
				join(PROJECT_CWD, ".env"),
				join(WORKTREE_PATH, ".env"),
			);
		});
	});
});
