import chalk from "chalk";

export const colors = {
	brand: chalk.cyan,
	success: chalk.green,
	warning: chalk.yellow,
	error: chalk.red,
	muted: chalk.gray,
	accent: chalk.magenta,
	heading: chalk.bold.white,
} as const;

export const symbols = {
	arrow: "›",
	check: "✓",
	cross: "✗",
	dot: "·",
	ellipsis: "…",
	line: "─",
} as const;

export function banner(): string {
	return `${colors.brand.bold("slice")} ${colors.muted("v0.1.0")}`;
}

export function divider(width = 40): string {
	return colors.muted(symbols.line.repeat(width));
}
