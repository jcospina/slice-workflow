import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "./logger";

describe("Logger", () => {
	let infoSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("defaults to info level", () => {
		const log = new Logger();
		expect(log.level).toBe("info");
	});

	it("respects custom level", () => {
		const log = new Logger("debug");
		expect(log.level).toBe("debug");
	});

	it("can change level at runtime", () => {
		const log = new Logger("info");
		log.setLevel("error");
		expect(log.level).toBe("error");
	});

	it("suppresses messages below the current level", () => {
		const log = new Logger("warn");
		log.debug("hidden");
		log.info("hidden");
		expect(infoSpy).not.toHaveBeenCalled();
	});

	it("outputs info messages via console.info", () => {
		const log = new Logger("info");
		log.info("hello");
		expect(infoSpy).toHaveBeenCalledOnce();
		expect(infoSpy.mock.calls[0][0]).toContain("hello");
	});

	it("outputs warn messages via console.warn", () => {
		const log = new Logger("info");
		log.warn("watch out");
		expect(warnSpy).toHaveBeenCalledOnce();
		expect(warnSpy.mock.calls[0][0]).toContain("watch out");
	});

	it("outputs error messages via console.error", () => {
		const log = new Logger("info");
		log.error("boom");
		expect(errorSpy).toHaveBeenCalledOnce();
		expect(errorSpy.mock.calls[0][0]).toContain("boom");
	});

	it("outputs debug messages when level is debug", () => {
		const log = new Logger("debug");
		log.debug("trace");
		expect(infoSpy).toHaveBeenCalledOnce();
		expect(infoSpy.mock.calls[0][0]).toContain("trace");
	});

	it("includes level tag in output", () => {
		const log = new Logger("info");
		log.info("test");
		expect(infoSpy.mock.calls[0][0]).toContain("INF");
	});

	it("includes context key-value pairs in output", () => {
		const log = new Logger("info");
		log.info("loaded", { file: "config.json", count: 3 });
		const output = infoSpy.mock.calls[0][0] as string;
		expect(output).toContain("file=");
		expect(output).toContain("config.json");
		expect(output).toContain("count=");
		expect(output).toContain("3");
	});
});
