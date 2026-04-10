#!/usr/bin/env node
/**
 * slice lifecycle hook — Telegram notification adapter
 *
 * Reference implementation showing how to forward slice lifecycle events to
 * Telegram using the Bot API. Copy this file to your own hooks directory and
 * configure it in ~/.slice/config.json or .slicerc.
 *
 * Required environment variables:
 *   TELEGRAM_BOT_TOKEN   Bot token from @BotFather (e.g. "123456:ABCdef...")
 *   TELEGRAM_CHAT_ID     Target chat or group ID (e.g. "-100123456789")
 *
 * Optional:
 *   DRY_RUN=1            Print the message instead of sending it (useful for testing)
 *
 * Usage in config:
 *   {
 *     "hooks": [
 *       {
 *         "command": "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID=$CHAT_ID node /path/to/notify-telegram.js",
 *         "events": ["workflow:complete", "workflow:failed", "approval:requested"],
 *         "async": true,
 *         "timeoutMs": 10000
 *       }
 *     ]
 *   }
 *
 * Test without a real token:
 *   echo '{"event":"workflow:complete","timestamp":"2026-04-09T00:00:00.000Z","runId":"run-1","payload":{"totalCostUsd":0.042}}' \
 *     | DRY_RUN=1 TELEGRAM_BOT_TOKEN=dummy TELEGRAM_CHAT_ID=-100123 node notify-telegram.js
 */

import https from "node:https";

// ---------------------------------------------------------------------------
// Read HookInput from stdin
// ---------------------------------------------------------------------------

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
	let input;
	try {
		input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		process.stderr.write("notify-telegram: failed to parse HookInput JSON from stdin\n");
		process.exit(1);
	}

	const message = formatMessage(input);
	if (process.env.DRY_RUN === "1") {
		process.stdout.write(
			`[DRY_RUN] Would send to Telegram chat ${process.env.TELEGRAM_CHAT_ID ?? "(no chat)"}: ${message}\n`,
		);
		process.exit(0);
	}

	sendTelegram(message).then(
		() => process.exit(0),
		(err) => {
			process.stderr.write(`notify-telegram: ${err.message}\n`);
			process.exit(1);
		},
	);
});

// ---------------------------------------------------------------------------
// Message formatting — one branch per lifecycle event
// ---------------------------------------------------------------------------

/**
 * @param {{ event: string, timestamp: string, runId?: string, payload: Record<string, unknown> }} input
 * @returns {string}
 */
function formatMessage(input) {
	const { event, runId = "unknown", payload } = input;
	const id = `[<code>${escHtml(runId)}</code>]`;

	switch (event) {
		case "workflow:start":
			return `🚀 <b>slice</b> workflow started\nTask: <b>${escHtml(String(payload.task))}</b>\nRun: <code>${escHtml(runId)}</code>`;

		case "workflow:complete":
			return `✅ <b>slice</b> workflow completed ${id}\nTotal cost: $${Number(payload.totalCostUsd).toFixed(4)}`;

		case "workflow:failed":
			return `❌ <b>slice</b> workflow failed ${id}\n${escHtml(String(payload.error))}`;

		case "phase:start":
			return `▶️ <b>slice</b> phase <b>${escHtml(String(payload.phase))}</b> started ${id}`;

		case "phase:complete":
			return `✔️ <b>slice</b> phase <b>${escHtml(String(payload.phase))}</b> complete ${id}\nCost: $${Number(payload.costUsd).toFixed(4)} · ${payload.durationMs}ms`;

		case "phase:failed":
			return `❌ <b>slice</b> phase <b>${escHtml(String(payload.phase))}</b> failed ${id}\n${escHtml(String(payload.error))}`;

		case "approval:requested": {
			const artifact = payload.artifactPath
				? `\nArtifact: <code>${escHtml(String(payload.artifactPath))}</code>`
				: "";
			return `🔔 <b>slice</b> approval requested\nPhase: <b>${escHtml(String(payload.phase))}</b> ${id}${artifact}`;
		}

		case "approval:received": {
			const feedback = payload.feedback ? `\n${escHtml(String(payload.feedback))}` : "";
			return `📋 <b>slice</b> approval <b>${escHtml(String(payload.decision))}</b>\nPhase: <b>${escHtml(String(payload.phase))}</b> ${id}${feedback}`;
		}

		default:
			return formatFutureEvent(event, payload, id, input.timestamp);
	}
}

/**
 * Format messages for not-yet-emitted events (slice:* / review:*) and unknown future events.
 * Keeping these separate reduces the cognitive complexity of formatMessage.
 *
 * @param {string} event
 * @param {Record<string, unknown>} payload
 * @param {string} id
 * @param {string} timestamp
 * @returns {string}
 */
function formatFutureEvent(event, payload, id, timestamp) {
	switch (event) {
		case "slice:start":
			return `▶️ <b>slice</b> executing slice ${payload.sliceIndex ?? "?"}${payload.sliceName ? ` — ${escHtml(String(payload.sliceName))}` : ""} ${id}`;

		case "slice:complete":
			return `✔️ <b>slice</b> slice ${payload.sliceIndex ?? "?"} complete ${id}\nCost: $${Number(payload.costUsd ?? 0).toFixed(4)} · ${payload.durationMs ?? 0}ms`;

		case "slice:failed":
			return `❌ <b>slice</b> slice ${payload.sliceIndex ?? "?"} failed ${id}\n${escHtml(String(payload.error ?? "unknown error"))}`;

		case "review:start":
			return `🔍 <b>slice</b> review started — slice ${payload.sliceIndex ?? "?"}, iteration ${payload.iteration ?? 1} ${id}`;

		case "review:verdict":
			return `📝 <b>slice</b> review verdict: <b>${escHtml(String(payload.verdict ?? "unknown"))}</b> — slice ${payload.sliceIndex ?? "?"} ${id}`;

		default:
			return `<b>slice</b> event <code>${escHtml(event)}</code> ${id} at ${timestamp}`;
	}
}

/**
 * Escape HTML special characters for Telegram's HTML parse mode.
 * Only <, >, and & are meaningful in Telegram HTML; all other characters are safe.
 * @param {string} text
 * @returns {string}
 */
function escHtml(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Telegram Bot API — sendMessage
// ---------------------------------------------------------------------------

/**
 * @param {string} text
 * @returns {Promise<void>}
 */
function sendTelegram(text) {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_CHAT_ID;

	if (!token) {
		throw new Error("TELEGRAM_BOT_TOKEN is not set");
	}
	if (!chatId) {
		throw new Error("TELEGRAM_CHAT_ID is not set");
	}

	// Telegram Bot API uses snake_case field names; naming convention warning is intentional here
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
				const parts = [];
				res.on("data", (chunk) => parts.push(chunk));
				res.on("end", () => {
					if (res.statusCode !== 200) {
						reject(new Error(`Telegram API returned HTTP ${res.statusCode}`));
						return;
					}
					let parsed;
					try {
						parsed = JSON.parse(Buffer.concat(parts).toString("utf8"));
					} catch {
						reject(new Error("Telegram API response was not valid JSON"));
						return;
					}
					if (parsed.ok) {
						resolve();
					} else {
						reject(
							new Error(
								`Telegram API error: ${parsed.description ?? parsed.error_code ?? "unknown"}`,
							),
						);
					}
				});
			},
		);

		req.on("error", reject);
		req.write(body);
		req.end();
	});
}
