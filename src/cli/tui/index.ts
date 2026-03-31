import { render } from "ink";
import { createElement } from "react";
import { App } from "./app";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";

export function startTui(): void {
	if (!process.stdin.isTTY) {
		console.error("slice: TUI requires an interactive terminal");
		process.exitCode = 1;
		return;
	}

	process.stdout.write(ENTER_ALT_SCREEN);

	const { waitUntilExit } = render(createElement(App), { exitOnCtrlC: false });

	waitUntilExit()
		.then(() => {
			process.stdout.write(EXIT_ALT_SCREEN);
		})
		.catch(() => {
			process.stdout.write(EXIT_ALT_SCREEN);
			process.exit(1);
		});
}
