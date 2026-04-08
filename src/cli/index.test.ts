import { describe, expect, it } from "vitest";
import { createProgram } from "./index";

const VERSION_RE = /0\.1\.0/;

function run(...args: string[]) {
	const program = createProgram();
	program.exitOverride();
	program.parse(["node", "slice", ...args]);
	return program;
}

function findCommand(name: string) {
	const program = createProgram();
	const cmd = program.commands.find((c) => c.name() === name);
	if (!cmd) {
		throw new Error(`command '${name}' not found`);
	}
	return cmd;
}

describe("createProgram", () => {
	it("registers the resume command", () => {
		const resume = findCommand("resume");
		expect(resume.description()).toBe("Resume work from PR feedback");
	});

	it("registers the setup-github command", () => {
		const setupGithub = findCommand("setup-github");
		expect(setupGithub.description()).toBe("Install the Slice GitHub Action in your repository");
	});

	it("registers the draft-polish command", () => {
		const draftPolish = findCommand("draft-polish");
		expect(draftPolish.description()).toBe(
			"Run the autonomous draft-polish phase for an RFC draft file",
		);
	});

	it("sets name and version", () => {
		const program = createProgram();
		expect(program.name()).toBe("slice");
		expect(program.version()).toBe("0.1.0");
	});

	it("parses resume --pr correctly", () => {
		const program = run("resume", "--pr", "123");
		const resume = program.commands.find((c) => c.name() === "resume");
		expect(resume?.opts()).toEqual({ pr: "123" });
	});

	it("parses setup-github correctly", () => {
		run("setup-github");
	});

	it("runs default action with no args (non-TTY prints error)", () => {
		run();
	});

	it("errors on unknown command", () => {
		expect(() => run("bogus")).toThrow("unknown command 'bogus'");
	});

	it("errors on unknown command even with flags", () => {
		expect(() => run("bogus", "--flag")).toThrow("unknown command 'bogus'");
	});

	it("errors on unknown option without a command", () => {
		expect(() => run("--whatever")).toThrow("unknown option '--whatever'");
	});

	it("outputs version with --version", () => {
		expect(() => run("--version")).toThrow(VERSION_RE);
	});

	it("outputs help with --help", () => {
		expect(() => run("--help")).toThrow("(outputHelp)");
	});
});
