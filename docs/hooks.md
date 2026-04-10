# slice Lifecycle Hooks

## Architecture overview

`slice` emits lifecycle events at key points during a workflow run. Instead of hardcoding notification channels, the orchestrator fires these events through a **hook runner** — a lightweight subprocess dispatcher that runs user-defined shell commands.

This means:
- The orchestrator has no built-in Slack, Telegram, or any other channel integration.
- Any channel you can reach from a shell command works.
- You can add, change, or remove channels without touching `slice`'s source code.

```
Orchestrator
    │
    ▼ HookInput (JSON) → stdin
  Hook script (your command)
    │
    ▼ HookOutput (JSON) ← stdout
Orchestrator reads { continue, reason }
```

### Blocking vs. async hooks

Each hook can be configured as **blocking** (default) or **async** (fire-and-forget):

| Mode | Behaviour |
|------|-----------|
| `async: false` (default) | Orchestrator awaits the hook. A `{ "continue": false }` response halts the workflow. |
| `async: true` | Hook is dispatched immediately; orchestrator continues without waiting. Hook output is ignored for control flow. |

For notification-only hooks (Slack, Telegram, etc.) always use `async: true`. Reserve blocking hooks for gates that must run before the workflow continues (e.g., a custom compliance check).

---

## Lifecycle event reference

| Event | Currently emitted | Payload fields |
|-------|:-----------------:|----------------|
| `workflow:start` | ✅ | `task: string`, `slug: string` |
| `workflow:complete` | ✅ | `totalCostUsd: number` |
| `workflow:failed` | ✅ | `error: string` |
| `phase:start` | ✅ | `phase: string` |
| `phase:complete` | ✅ | `phase: string`, `costUsd: number`, `durationMs: number` |
| `phase:failed` | ✅ | `phase: string`, `error: string` |
| `approval:requested` | ✅ | `phase: string`, `artifactPath: string` |
| `approval:received` | ✅ | `phase: string`, `decision: "approved" \| "request_changes" \| "rejected"`, `feedback?: string` |
| `slice:start` | ⏳ planned | `sliceIndex: number`, `sliceName: string` |
| `slice:complete` | ⏳ planned | `sliceIndex: number`, `sliceName: string`, `costUsd: number`, `durationMs: number` |
| `slice:failed` | ⏳ planned | `sliceIndex: number`, `sliceName: string`, `error: string` |
| `review:start` | ⏳ planned | `sliceIndex: number`, `iteration: number` |
| `review:verdict` | ⏳ planned | `sliceIndex: number`, `iteration: number`, `verdict: "PASS" \| "FAIL"`, `findings: object[]` |

> **Note**: `slice:*` and `review:*` events are defined and handled by the hook runner, but are not yet emitted — they will fire once the execute-slices phase is implemented. Reference adapters handle these events gracefully today with a generic fallback message.

### Full input/output schema

Every hook receives a `HookInput` object on stdin:

```typescript
interface HookInput {
  event: HookEvent;          // one of the 13 events above
  timestamp: string;         // ISO 8601, e.g. "2026-04-09T12:34:56.789Z"
  runId?: string;            // workflow run ID; undefined only at workflow:start
  payload: Record<string, unknown>;  // event-specific fields (see table above)
}
```

A hook can write a `HookOutput` object to stdout to influence control flow:

```typescript
interface HookOutput {
  continue?: boolean;   // default: true. Set false to halt the orchestrator (blocking hooks only)
  reason?: string;      // human-readable reason shown when continue is false
}
```

- Empty stdout is treated as `{}` (continue).
- Malformed JSON on stdout is logged as a non-blocking failure; the orchestrator continues.
- Non-zero exit codes are logged as failures; the orchestrator continues regardless.

---

## Hook config reference

Hooks are defined in `~/.slice/config.json` (global) and/or `.slicerc` (project-level).

```typescript
interface HookDefinition {
  command: string;        // shell command to run
  events: HookEvent[];    // which events trigger this hook
  matcher?: string;       // optional regex filter (tested against serialized HookInput JSON)
  timeoutMs?: number;     // per-hook timeout in ms; default 5000
  async?: boolean;        // fire-and-forget; default false
}
```

### Global config (`~/.slice/config.json`)

Global hooks apply to every project. They run first in the merged hook list.

```json
{
  "defaultProvider": "claude-code",
  "hooks": [
    {
      "command": "SLACK_BOT_TOKEN=xoxb-... SLACK_CHANNEL=#deployments node ~/hooks/notify-slack.js",
      "events": ["workflow:start", "workflow:complete", "workflow:failed"],
      "async": true,
      "timeoutMs": 10000
    }
  ]
}
```

### Project config (`.slicerc`)

Project hooks append after global hooks. Use them to add project-specific routing.

```json
{
  "hooks": [
    {
      "command": "TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=-100... node ~/hooks/notify-telegram.js",
      "events": ["approval:requested"],
      "async": true
    }
  ]
}
```

### Merge order

`resolvedHooks = [...globalHooks, ...projectHooks]`

Global hooks always execute before project hooks for the same event.

### Matcher syntax

The `matcher` field is a regex pattern tested against the **full serialized HookInput JSON string**. If it doesn't match, the hook is skipped for that event.

```json
{ "matcher": "\"phase\":\"plan\"" }
```

This fires only when the serialized input contains `"phase":"plan"`. Examples:

| Matcher | Fires on |
|---------|----------|
| `":failed"` | All `*:failed` events |
| `"\"phase\":\"plan\""` | Any event where payload.phase is "plan" |
| `"approval:"` | Both `approval:requested` and `approval:received` |
| `"\"decision\":\"rejected\""` | Only rejected approvals |

---

## How to build a channel integration

Any notification channel that accepts HTTP (or a command-line tool) can be wired up in four steps. Here is the general pattern, then concrete examples for Slack and Telegram.

### Step 1 — Read HookInput from stdin

Your script receives a JSON payload on stdin. The exact format is `HookInput` above.

**Node.js pattern (recommended — no extra dependencies beyond Node itself):**

```javascript
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  // input.event, input.runId, input.payload are now available
});
```

**Shell pattern (requires `jq`):**

```bash
INPUT=$(cat)
EVENT=$(echo "$INPUT" | jq -r '.event')
RUN_ID=$(echo "$INPUT" | jq -r '.runId // "unknown"')
```

### Step 2 — Map events to messages

Use a `switch` (Node.js) or `case` (bash) to pull the relevant fields for each event and format a human-readable message. Always include a default/wildcard case to handle future events gracefully.

```javascript
switch (input.event) {
  case "workflow:complete":
    return `Workflow done. Cost: $${input.payload.totalCostUsd}`;
  // ...other events...
  default:
    return `slice event: ${input.event} (run ${input.runId})`;
}
```

### Step 3 — Call your channel's API

Use Node.js's built-in `https.request` (no extra npm packages needed), `curl` in bash, or any other HTTP client.

```javascript
const body = JSON.stringify({ channel: "#alerts", text: message });
// POST to https://your-api.example.com/messages with appropriate auth headers
```

### Step 4 — Handle errors and test locally

- Write errors to stderr; exit non-zero on failure. The orchestrator logs hook failures but never aborts the workflow because of them.
- Support a `DRY_RUN=1` env var that skips the HTTP call and prints the message instead. This makes local testing trivial.

```javascript
if (process.env.DRY_RUN === "1") {
  process.stdout.write(`[DRY_RUN] Would notify: ${message}\n`);
  process.exit(0);
}
```

**Test any adapter without real credentials:**

```bash
echo '{"event":"workflow:complete","timestamp":"2026-04-09T00:00:00Z","runId":"run-1","payload":{"totalCostUsd":0.05}}' \
  | DRY_RUN=1 node /path/to/your-adapter.js
```

---

## Slack reference implementation

See [`docs/hooks/notify-slack.js`](hooks/notify-slack.js).

### Setup

1. Create a Slack app at https://api.slack.com/apps
2. Enable **Bot Token Scopes** → add `chat:write`
3. Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`)
4. Invite the bot to your target channel: `/invite @your-app-name`
5. Copy `docs/hooks/notify-slack.js` to a stable path (e.g., `~/hooks/notify-slack.js`)

### Config

```json
{
  "hooks": [
    {
      "command": "SLACK_BOT_TOKEN=xoxb-YOUR-TOKEN SLACK_CHANNEL=#your-channel node ~/hooks/notify-slack.js",
      "events": ["workflow:start", "workflow:complete", "workflow:failed", "phase:failed", "approval:requested", "approval:received"],
      "async": true,
      "timeoutMs": 10000
    }
  ]
}
```

### Test locally

```bash
echo '{"event":"workflow:complete","timestamp":"2026-04-09T00:00:00.000Z","runId":"run-abc","payload":{"totalCostUsd":0.042}}' \
  | DRY_RUN=1 SLACK_BOT_TOKEN=dummy SLACK_CHANNEL=#test node ~/hooks/notify-slack.js
```

Expected output: `[DRY_RUN] Would send to Slack #test: *slice* workflow completed...`

### Design notes in the reference script

- Uses `https.request` from Node.js built-ins — no `npm install` required.
- Checks the Slack API `ok` field in the response body (HTTP 200 does not guarantee delivery).
- Exits non-zero on API errors so the orchestrator logs the failure.
- The default `switch` case handles `slice:*` and `review:*` events with a generic message, so the script won't break when those events are emitted in a future release.

---

## Telegram reference implementation

See [`docs/hooks/notify-telegram.js`](hooks/notify-telegram.js).

### Setup

1. Message @BotFather on Telegram → `/newbot` → follow prompts → copy the token
2. Add the bot to a group, or use a personal chat ID
3. To find your `CHAT_ID`: send any message to the bot, then call
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `.result[0].message.chat.id`
4. Copy `docs/hooks/notify-telegram.js` to a stable path

### Config

```json
{
  "hooks": [
    {
      "command": "TELEGRAM_BOT_TOKEN=123:ABC TELEGRAM_CHAT_ID=-100456 node ~/hooks/notify-telegram.js",
      "events": ["workflow:complete", "workflow:failed", "approval:requested"],
      "async": true,
      "timeoutMs": 10000
    }
  ]
}
```

### Test locally

```bash
echo '{"event":"approval:requested","timestamp":"2026-04-09T00:00:00.000Z","runId":"run-abc","payload":{"phase":"plan","artifactPath":"/path/to/plan.md"}}' \
  | DRY_RUN=1 TELEGRAM_BOT_TOKEN=dummy TELEGRAM_CHAT_ID=-100test node ~/hooks/notify-telegram.js
```

### Design notes in the reference script

- Uses MarkdownV2 parse mode with special-character escaping (`escMd` helper).
- Sends via `POST /bot<token>/sendMessage` in the Telegram Bot API.
- Checks `parsed.ok` in the response (same pattern as Slack).

---

## Adding a new channel: Discord example

See [`docs/hooks/notify-discord.js`](hooks/notify-discord.js).

This script demonstrates that adding any new channel requires **zero changes to `slice`'s source code**.

### Setup (Discord Incoming Webhook)

1. Open your Discord server → channel settings → Integrations → Webhooks → New Webhook
2. Copy the Webhook URL
3. Copy `docs/hooks/notify-discord.js` to `~/hooks/notify-discord.js`

### Config

```json
{
  "hooks": [
    {
      "command": "DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... node ~/hooks/notify-discord.js",
      "events": ["workflow:complete", "workflow:failed"],
      "async": true
    }
  ]
}
```

### Test

```bash
echo '{"event":"workflow:failed","timestamp":"2026-04-09T00:00:00.000Z","runId":"run-abc","payload":{"error":"Agent exceeded max turns"}}' \
  | DRY_RUN=1 DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/test/test node ~/hooks/notify-discord.js
```

The same pattern applies to any webhook-style service: PagerDuty, Microsoft Teams, custom HTTP endpoints, etc.

---

## Migration guide: from `messaging.*` to hooks

Earlier versions of `slice` had a built-in `messaging.slack` and `messaging.telegram` configuration block. Those fields are still accepted by the config schema but are deprecated — the hardcoded integration paths they backed are being removed in favour of hook adapters.

### Before (legacy `~/.slice/config.json`)

```json
{
  "messaging": {
    "slack": {
      "appToken": "xapp-...",
      "botToken": "xoxb-...",
      "defaultChannel": "#notifications"
    },
    "telegram": {
      "botToken": "123:ABC",
      "chatId": "-100456"
    }
  }
}
```

### After (hook-based `~/.slice/config.json`)

```json
{
  "hooks": [
    {
      "command": "SLACK_BOT_TOKEN=xoxb-... SLACK_CHANNEL=#notifications node ~/hooks/notify-slack.js",
      "events": ["workflow:start", "workflow:complete", "workflow:failed", "approval:requested", "approval:received"],
      "async": true
    },
    {
      "command": "TELEGRAM_BOT_TOKEN=123:ABC TELEGRAM_CHAT_ID=-100456 node ~/hooks/notify-telegram.js",
      "events": ["workflow:complete", "workflow:failed"],
      "async": true
    }
  ]
}
```

### Migration steps

1. Copy `docs/hooks/notify-slack.js` and/or `docs/hooks/notify-telegram.js` to `~/hooks/` (or any stable path).
2. Add the hook entries above to `~/.slice/config.json`, substituting your real tokens.
3. Test with `DRY_RUN=1` (see testing commands in each adapter section above).
4. Remove the `messaging.*` block from your config.

---

## Custom script template

Minimal starting point for a completely custom side-effect (logging, metrics, custom webhook):

```javascript
#!/usr/bin/env node
"use strict";

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));

  const message = buildMessage(input);

  if (process.env.DRY_RUN === "1") {
    process.stdout.write(`[DRY_RUN] ${message}\n`);
    process.exit(0);
  }

  // Replace with your actual delivery logic:
  //   - write to a file
  //   - POST to an internal API
  //   - run a CLI tool
  process.stdout.write(`Delivered: ${message}\n`);
  process.exit(0);
});

function buildMessage(input) {
  const { event, runId = "unknown", payload } = input;
  switch (event) {
    case "workflow:complete":
      return `Done: run ${runId}, cost $${payload.totalCostUsd}`;
    default:
      return `${event} for run ${runId}`;
  }
}
```

---

## Validation checklist

Use this checklist to confirm your hook integration is working end-to-end.

- [ ] Adapter script runs locally with `DRY_RUN=1` for all event types you care about
- [ ] Output line starts with `[DRY_RUN]` (confirms the env var guard is working)
- [ ] Config JSON is accepted by `slice` without validation errors
- [ ] Matcher regex (if used) filters to the expected events — test with a non-matching payload
- [ ] Global and project hooks merge in the right order (global fires first)
- [ ] Hook is marked `async: true` if it should not block the workflow
- [ ] Script exits non-zero when required env vars are missing
- [ ] Script handles an unrecognised event (default/wildcard case) without crashing
- [ ] Adapter script handles future `slice:*` / `review:*` events gracefully (already true for scripts derived from the reference implementations)
- [ ] New channel (e.g. Discord) added with zero changes to `slice` source code
