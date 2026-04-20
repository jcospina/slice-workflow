import https from "node:https";
import { readHookInputFromStdin, toSafeNumber, toSafeString } from "./common";

interface AdapterInput {
	event: string;
	timestamp: string;
	runId?: string;
	payload: Record<string, unknown>;
}

run().catch((error: unknown) => {
	process.stderr.write(
		`notify-telegram: ${toSafeString(error instanceof Error ? error.message : error)}\n`,
	);
	process.exit(1);
});

async function run(): Promise<void> {
	const input = (await readHookInputFromStdin("notify-telegram")) as AdapterInput;
	const message = formatMessage(input);

	if (process.env.DRY_RUN === "1") {
		process.stderr.write(
			`[DRY_RUN] Would send to Telegram chat ${process.env.TELEGRAM_CHAT_ID ?? "(no chat)"}: ${message}\n`,
		);
		return;
	}

	await sendTelegram(message);
}

function formatMessage(input: AdapterInput): string {
	const { event, runId = "unknown", payload } = input;
	const id = `[<code>${escHtml(runId)}</code>]`;

	switch (event) {
		case "workflow:start":
			return `<b>slice</b> workflow started\nTask: <b>${escHtml(toSafeString(payload.task))}</b>\nRun: <code>${escHtml(runId)}</code>`;
		case "workflow:complete":
			return `<b>slice</b> workflow completed ${id}\nTotal cost: $${toSafeNumber(payload.totalCostUsd).toFixed(4)}`;
		case "workflow:failed":
			return `<b>slice</b> workflow failed ${id}\n${escHtml(toSafeString(payload.error))}`;
		case "phase:start":
			return `<b>slice</b> phase <b>${escHtml(toSafeString(payload.phase))}</b> started ${id}`;
		case "phase:complete":
			return `<b>slice</b> phase <b>${escHtml(toSafeString(payload.phase))}</b> complete ${id}\nCost: $${toSafeNumber(payload.costUsd).toFixed(4)} | ${toSafeNumber(payload.durationMs)}ms`;
		case "phase:failed":
			return `<b>slice</b> phase <b>${escHtml(toSafeString(payload.phase))}</b> failed ${id}\n${escHtml(toSafeString(payload.error))}`;
		case "approval:requested": {
			const artifact = payload.artifactPath
				? `\nArtifact: <code>${escHtml(toSafeString(payload.artifactPath))}</code>`
				: "";
			return `<b>slice</b> approval requested\nPhase: <b>${escHtml(toSafeString(payload.phase))}</b> ${id}${artifact}`;
		}
		case "approval:received": {
			const feedback = payload.feedback ? `\n${escHtml(toSafeString(payload.feedback))}` : "";
			return `<b>slice</b> approval <b>${escHtml(toSafeString(payload.decision))}</b>\nPhase: <b>${escHtml(toSafeString(payload.phase))}</b> ${id}${feedback}`;
		}
		default:
			return formatFutureEvent(event, payload, id, input.timestamp);
	}
}

function formatFutureEvent(
	event: string,
	payload: Record<string, unknown>,
	id: string,
	timestamp: string,
): string {
	switch (event) {
		case "slice:start":
			return `<b>slice</b> executing slice ${escHtml(toSafeString(payload.sliceIndex, "?"))}${payload.sliceName ? ` - ${escHtml(toSafeString(payload.sliceName))}` : ""} ${id}`;
		case "slice:complete":
			return `<b>slice</b> slice ${escHtml(toSafeString(payload.sliceIndex, "?"))} complete ${id}\nCost: $${toSafeNumber(payload.costUsd).toFixed(4)} | ${toSafeNumber(payload.durationMs)}ms`;
		case "slice:failed":
			return `<b>slice</b> slice ${escHtml(toSafeString(payload.sliceIndex, "?"))} failed ${id}\n${escHtml(toSafeString(payload.error))}`;
		case "slice:approval_requested":
			return `<b>slice</b> approval requested for slice ${escHtml(toSafeString(payload.sliceIndex, "?"))}${payload.sliceName ? ` - ${escHtml(toSafeString(payload.sliceName))}` : ""} ${id}`;
		case "slice:approval_received":
			return `<b>slice</b> approval <b>${escHtml(toSafeString(payload.decision))}</b> for slice ${escHtml(toSafeString(payload.sliceIndex, "?"))}${payload.sliceName ? ` - ${escHtml(toSafeString(payload.sliceName))}` : ""} ${id}`;
		case "review:start":
			return `<b>slice</b> review started - slice ${escHtml(toSafeString(payload.sliceIndex, "?"))}, iteration ${escHtml(toSafeString(payload.iteration, "1"))} ${id}`;
		case "review:verdict":
			return `<b>slice</b> review verdict: <b>${escHtml(toSafeString(payload.verdict))}</b> - slice ${escHtml(toSafeString(payload.sliceIndex, "?"))} ${id}`;
		default:
			return `<b>slice</b> event <code>${escHtml(event)}</code> ${id} at ${timestamp}`;
	}
}

function escHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function handleTelegramResponseEnd(
	parts: Buffer[],
	statusCode: number | undefined,
	resolve: () => void,
	reject: (err: Error) => void,
): void {
	if (statusCode !== 200) {
		reject(new Error(`Telegram API returned HTTP ${statusCode}`));
		return;
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(Buffer.concat(parts).toString("utf8"));
	} catch {
		reject(new Error("Telegram API response was not valid JSON"));
		return;
	}
	if (parsed.ok === true) {
		resolve();
		return;
	}
	const description = typeof parsed.description === "string" ? parsed.description : undefined;
	const errorCode = typeof parsed.error_code === "number" ? parsed.error_code : undefined;
	reject(new Error(`Telegram API error: ${description ?? String(errorCode ?? "unknown")}`));
}

function sendTelegram(text: string): Promise<void> {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_CHAT_ID;

	if (!token) {
		return Promise.reject(new Error("TELEGRAM_BOT_TOKEN is not set"));
	}
	if (!chatId) {
		return Promise.reject(new Error("TELEGRAM_CHAT_ID is not set"));
	}

	// biome-ignore lint/style/useNamingConvention: Telegram API requires snake_case keys
	const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });

	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				hostname: "api.telegram.org",
				path: `/bot${token}/sendMessage`,
				method: "POST",
				headers: {
					"Content-Type": "application/json; charset=utf-8",
					"Content-Length": Buffer.byteLength(body),
				},
			},
			(res) => {
				const parts: Buffer[] = [];
				res.on("data", (chunk: Buffer | string) => {
					parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});
				res.on("end", () => handleTelegramResponseEnd(parts, res.statusCode, resolve, reject));
			},
		);

		req.on("error", reject);
		req.write(body);
		req.end();
	});
}
