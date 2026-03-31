import chalk from "chalk";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const LEVEL_STYLE: Record<LogLevel, (text: string) => string> = {
	debug: chalk.gray,
	info: chalk.blue,
	warn: chalk.yellow,
	error: chalk.red,
};

const LEVEL_TAG: Record<LogLevel, string> = {
	debug: "DBG",
	info: "INF",
	warn: "WRN",
	error: "ERR",
};

function formatTimestamp(): string {
	const now = new Date();
	const h = String(now.getHours()).padStart(2, "0");
	const m = String(now.getMinutes()).padStart(2, "0");
	const s = String(now.getSeconds()).padStart(2, "0");
	return chalk.gray(`${h}:${m}:${s}`);
}

function formatContext(context: Record<string, unknown>): string {
	const entries = Object.entries(context);
	if (entries.length === 0) {
		return "";
	}
	const parts = entries.map(([k, v]) => `${chalk.gray(`${k}=`)}${String(v)}`);
	return ` ${parts.join(" ")}`;
}

export class Logger {
	level: LogLevel;

	constructor(level: LogLevel = "info") {
		this.level = level;
	}

	setLevel(level: LogLevel): void {
		this.level = level;
	}

	debug(message: string, context: Record<string, unknown> = {}): void {
		this.log("debug", message, context);
	}

	info(message: string, context: Record<string, unknown> = {}): void {
		this.log("info", message, context);
	}

	warn(message: string, context: Record<string, unknown> = {}): void {
		this.log("warn", message, context);
	}

	error(message: string, context: Record<string, unknown> = {}): void {
		this.log("error", message, context);
	}

	private log(level: LogLevel, message: string, context: Record<string, unknown>): void {
		if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) {
			return;
		}

		const timestamp = formatTimestamp();
		const tag = LEVEL_STYLE[level](LEVEL_TAG[level]);
		const ctx = formatContext(context);
		const line = `${timestamp} ${tag} ${message}${ctx}`;

		if (level === "error") {
			console.error(line);
		} else if (level === "warn") {
			console.warn(line);
		} else {
			console.info(line);
		}
	}
}

export const logger = new Logger();
