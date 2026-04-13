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
		`notify-slack: ${toSafeString(error instanceof Error ? error.message : error)}\n`,
	);
	process.exit(1);
});

async function run(): Promise<void> {
	const input = (await readHookInputFromStdin("notify-slack")) as AdapterInput;
	const message = formatMessage(input);

	if (process.env.DRY_RUN === "1") {
		process.stderr.write(
			`[DRY_RUN] Would send to Slack ${process.env.SLACK_CHANNEL ?? "(no channel)"}: ${message}\n`,
		);
		return;
	}

	await sendSlack(message);
}

function formatMessage(input: AdapterInput): string {
	const { event, runId = "unknown", payload } = input;
	const id = `\`${runId}\``;

	switch (event) {
		case "workflow:start":
			return `slice workflow started - task: *${toSafeString(payload.task)}* (run ${id}, slug: \`${toSafeString(payload.slug)}\`)`;
		case "workflow:complete":
			return `slice workflow completed (run ${id}). Total cost: $${toSafeNumber(payload.totalCostUsd).toFixed(4)}`;
		case "workflow:failed":
			return `slice workflow failed (run ${id}): ${toSafeString(payload.error)}`;
		case "phase:start":
			return `slice phase *${toSafeString(payload.phase)}* started (run ${id})`;
		case "phase:complete":
			return `slice phase *${toSafeString(payload.phase)}* complete (run ${id}) - cost: $${toSafeNumber(payload.costUsd).toFixed(4)}, duration: ${toSafeNumber(payload.durationMs)}ms`;
		case "phase:failed":
			return `slice phase *${toSafeString(payload.phase)}* failed (run ${id}): ${toSafeString(payload.error)}`;
		case "approval:requested": {
			const artifact = payload.artifactPath
				? ` Artifact: \`${toSafeString(payload.artifactPath)}\``
				: "";
			return `slice approval requested for phase *${toSafeString(payload.phase)}* (run ${id}).${artifact}`;
		}
		case "approval:received": {
			const feedback = payload.feedback ? `: ${toSafeString(payload.feedback)}` : "";
			return `slice approval *${toSafeString(payload.decision)}* for phase *${toSafeString(payload.phase)}* (run ${id})${feedback}`;
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
			return `slice executing slice ${toSafeString(payload.sliceIndex, "?")}${payload.sliceName ? ` - ${toSafeString(payload.sliceName)}` : ""} (run ${id})`;
		case "slice:complete":
			return `slice slice ${toSafeString(payload.sliceIndex, "?")} complete (run ${id}) - cost: $${toSafeNumber(payload.costUsd).toFixed(4)}, duration: ${toSafeNumber(payload.durationMs)}ms`;
		case "slice:failed":
			return `slice slice ${toSafeString(payload.sliceIndex, "?")} failed (run ${id}): ${toSafeString(payload.error)}`;
		case "review:start":
			return `slice review started for slice ${toSafeString(payload.sliceIndex, "?")}, iteration ${toSafeString(payload.iteration, "1")} (run ${id})`;
		case "review:verdict":
			return `slice review verdict for slice ${toSafeString(payload.sliceIndex, "?")}: *${toSafeString(payload.verdict)}* (run ${id})`;
		default:
			return `slice event \`${event}\` (run ${id}) at ${timestamp}`;
	}
}

function sendSlack(text: string): Promise<void> {
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
				const parts: Buffer[] = [];
				res.on("data", (chunk: Buffer | string) => {
					parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});
				res.on("end", () => {
					if (res.statusCode !== 200) {
						reject(new Error(`Slack API returned HTTP ${res.statusCode}`));
						return;
					}

					let parsed: { ok?: boolean; channel?: string; ts?: string; error?: string };
					try {
						parsed = JSON.parse(Buffer.concat(parts).toString("utf8"));
					} catch {
						reject(new Error("Slack API response was not valid JSON"));
						return;
					}

					if (parsed.ok) {
						process.stderr.write(
							`notify-slack: sent to channel ${parsed.channel ?? "unknown"} (ts: ${parsed.ts ?? "unknown"})\n`,
						);
						resolve();
						return;
					}

					reject(new Error(`Slack API error: ${parsed.error ?? "unknown"}`));
				});
			},
		);

		req.on("error", reject);
		req.write(body);
		req.end();
	});
}
