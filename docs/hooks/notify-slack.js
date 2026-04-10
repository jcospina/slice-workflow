#!/usr/bin/env node
/**
 * slice lifecycle hook — Slack notification adapter
 *
 * Reference implementation showing how to forward slice lifecycle events to
 * Slack using the Bot API. Copy this file to your own hooks directory and
 * configure it in ~/.slice/config.json or .slicerc.
 *
 * Required environment variables:
 *   SLACK_BOT_TOKEN   Bot token (xoxb-...) from your Slack app's OAuth settings
 *   SLACK_CHANNEL     Channel ID to post to (e.g. "C01234ABCDE"). Always use the ID, not the
 *                    name — Slack's API requires IDs for reliable delivery. Find the ID in Slack
 *                    by opening the channel → click the channel name → scroll to the bottom of
 *                    the About panel.
 *
 * Optional:
 *   DRY_RUN=1         Print the message instead of sending it (useful for testing)
 *
 * Usage in config:
 *   {
 *     "hooks": [
 *       {
 *         "command": "SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN SLACK_CHANNEL=C01234ABCDE node /path/to/notify-slack.js",
 *         "events": ["workflow:start", "workflow:complete", "workflow:failed", "approval:requested"],
 *         "async": true,
 *         "timeoutMs": 10000
 *       }
 *     ]
 *   }
 *
 * Test without a real token:
 *   echo '{"event":"workflow:complete","timestamp":"2026-04-09T00:00:00.000Z","runId":"run-1","payload":{"totalCostUsd":0.042}}' \
 *     | DRY_RUN=1 SLACK_BOT_TOKEN=dummy SLACK_CHANNEL=C01234ABCDE node notify-slack.js
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
		process.stderr.write("notify-slack: failed to parse HookInput JSON from stdin\n");
		process.exit(1);
	}

	const message = formatMessage(input);
	if (process.env.DRY_RUN === "1") {
		process.stdout.write(
			`[DRY_RUN] Would send to Slack ${process.env.SLACK_CHANNEL ?? "(no channel)"}: ${message}\n`,
		);
		process.exit(0);
	}

	sendSlack(message).then(
		() => process.exit(0),
		(err) => {
			process.stderr.write(`notify-slack: ${err.message}\n`);
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
	const id = `\`${runId}\``;

	switch (event) {
		case "workflow:start":
			return `*slice* workflow started — task: *${payload.task}* (run ${id}, slug: \`${payload.slug}\`)`;

		case "workflow:complete":
			return `*slice* workflow completed (run ${id}). Total cost: $${Number(payload.totalCostUsd).toFixed(4)}`;

		case "workflow:failed":
			return `:x: *slice* workflow failed (run ${id}): ${payload.error}`;

		case "phase:start":
			return `*slice* phase *${payload.phase}* started (run ${id})`;

		case "phase:complete":
			return `*slice* phase *${payload.phase}* complete (run ${id}) — cost: $${Number(payload.costUsd).toFixed(4)}, duration: ${payload.durationMs}ms`;

		case "phase:failed":
			return `:x: *slice* phase *${payload.phase}* failed (run ${id}): ${payload.error}`;

		case "approval:requested": {
			const artifact = payload.artifactPath ? ` Artifact: \`${payload.artifactPath}\`` : "";
			return `:bell: *slice* approval requested for phase *${payload.phase}* (run ${id}).${artifact}`;
		}

		case "approval:received": {
			const feedback = payload.feedback ? `: ${payload.feedback}` : "";
			return `*slice* approval *${payload.decision}* for phase *${payload.phase}* (run ${id})${feedback}`;
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
			return `*slice* executing slice ${payload.sliceIndex ?? "?"}${payload.sliceName ? ` — ${payload.sliceName}` : ""} (run ${id})`;

		case "slice:complete":
			return `*slice* slice ${payload.sliceIndex ?? "?"} complete (run ${id}) — cost: $${Number(payload.costUsd ?? 0).toFixed(4)}, duration: ${payload.durationMs ?? 0}ms`;

		case "slice:failed":
			return `:x: *slice* slice ${payload.sliceIndex ?? "?"} failed (run ${id}): ${payload.error ?? "unknown error"}`;

		case "review:start":
			return `*slice* review started for slice ${payload.sliceIndex ?? "?"}, iteration ${payload.iteration ?? 1} (run ${id})`;

		case "review:verdict":
			return `*slice* review verdict for slice ${payload.sliceIndex ?? "?"}: *${payload.verdict}* (run ${id})`;

		default:
			return `*slice* event \`${event}\` (run ${id}) at ${timestamp}`;
	}
}

// ---------------------------------------------------------------------------
// Slack Bot API — chat.postMessage
// ---------------------------------------------------------------------------

/**
 * @param {string} text
 * @returns {Promise<void>}
 */
function sendSlack(text) {
	const token = process.env.SLACK_BOT_TOKEN;
	const channel = process.env.SLACK_CHANNEL;

	if (!token) {
		return Promise.reject(new Error("SLACK_BOT_TOKEN is not set"));
	}
	if (!channel) {
		return Promise.reject(new Error("SLACK_CHANNEL is not set"));
	}

	const body = JSON.stringify({ channel, text });

	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				hostname: "slack.com",
				path: "/api/chat.postMessage",
				method: "POST",
				headers: {
					// biome-ignore lint/style/useNamingConvention: HTTP header name per Slack API spec
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json; charset=utf-8",
					"Content-Length": Buffer.byteLength(body),
				},
			},
			(res) => {
				const parts = [];
				res.on("data", (chunk) => parts.push(chunk));
				res.on("end", () => {
					if (res.statusCode !== 200) {
						reject(new Error(`Slack API returned HTTP ${res.statusCode}`));
						return;
					}
					let parsed;
					try {
						parsed = JSON.parse(Buffer.concat(parts).toString("utf8"));
					} catch {
						reject(new Error("Slack API response was not valid JSON"));
						return;
					}
					if (parsed.ok) {
						process.stdout.write(
							`notify-slack: sent to channel ${parsed.channel} (ts: ${parsed.ts})\n`,
						);
						resolve();
					} else {
						reject(new Error(`Slack API error: ${parsed.error ?? "unknown"}`));
					}
				});
			},
		);

		req.on("error", reject);
		req.write(body);
		req.end();
	});
}
