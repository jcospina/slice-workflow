# slice Lifecycle Hooks

## Architecture overview

`slice` emits lifecycle events during workflow execution and delivers them through a hook runner.
Hooks are subprocess commands that receive `HookInput` JSON on stdin.

This keeps notification channels decoupled from the orchestrator:
- Hooks are configured by users.
- Built-in adapters (`slack`, `telegram`) are bundled with `slice`.
- Custom channels still work through plain shell commands.

```text
Orchestrator
    |
    v HookInput (JSON) -> stdin
  Hook command / adapter
    |
    v HookOutput (JSON) <- stdout
Orchestrator reads { continue, reason }
```

## Blocking vs async hooks

| Mode | Behavior |
|------|----------|
| `async: false` | Orchestrator waits for hook completion. `{"continue": false}` can stop the workflow. |
| `async: true` | Fire-and-forget. Output does not affect control flow. |

Defaults:
- `command` hooks default to `async: false`.
- `adapter` hooks default to `async: true`.

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
| `slice:start` | ✅ | `sliceIndex: number`, `sliceName: string` |
| `slice:complete` | ✅ | `sliceIndex: number`, `sliceName: string`, `costUsd: number`, `durationMs: number` |
| `slice:failed` | ✅ | `sliceIndex: number`, `sliceName: string`, `error: string` |
| `slice:approval_requested` | ✅ | `sliceIndex: number`, `sliceName: string`, `artifactPath: string` |
| `slice:approval_received` | ✅ | `sliceIndex: number`, `sliceName: string`, `decision: "approved" \| "request_changes" \| "rejected"` |
| `review:start` | ✅ | `sliceIndex: number`, `iteration: number` |
| `review:verdict` | ✅ | `sliceIndex: number`, `iteration: number`, `verdict: "PASS" \| "FAIL" \| "PARTIAL"` |

## Hook input/output schema

```ts
interface HookInput {
  event: HookEvent;
  timestamp: string;
  runId?: string;
  payload: Record<string, unknown>;
}

interface HookOutput {
  continue?: boolean;
  reason?: string;
}
```

Runtime behavior:
- Empty stdout is treated as `{}`.
- Malformed stdout JSON is logged as a hook failure.
- Non-zero exit codes are logged as hook failures.
- Hook failures do not crash the orchestrator.

## Hook config reference

Hooks are defined in `~/.slice/config.json` and/or `.slicerc`.
Resolved order is always:

`resolvedHooks = [...globalHooks, ...projectHooks]`

```ts
interface HookDefinition {
  command?: string;                  // custom shell command
  adapter?: "slack" | "telegram"; // bundled adapter
  events: HookEvent[];
  matcher?: string;
  timeoutMs?: number;
  async?: boolean;
  envFrom?: Record<string, string>;  // target env -> source env variable name
}
```

Rules:
- Exactly one of `command` or `adapter` is required.
- `events` is always required.
- `envFrom` can be used on both `command` and `adapter` hooks.

### `envFrom` (secrets from env)

`envFrom` maps env vars expected by the hook command to env vars already present in the shell environment.

Example:

```json
{
  "envFrom": {
    "SLACK_BOT_TOKEN": "SLICE_SLACK_BOT_TOKEN",
    "SLACK_CHANNEL": "SLICE_SLACK_CHANNEL"
  }
}
```

In this example, the hook receives `SLACK_BOT_TOKEN` and `SLACK_CHANNEL`, but the config only stores source env variable names.

## Built-in adapter: Slack

Configuration:

```json
{
  "hooks": [
    {
      "adapter": "slack",
      "events": ["workflow:start", "workflow:complete", "workflow:failed", "phase:failed", "approval:requested", "approval:received"],
      "envFrom": {
        "SLACK_BOT_TOKEN": "SLICE_SLACK_BOT_TOKEN",
        "SLACK_CHANNEL": "SLICE_SLACK_CHANNEL"
      },
      "timeoutMs": 10000
    }
  ]
}
```

Required env vars for the adapter process:
- `SLACK_BOT_TOKEN`
- `SLACK_CHANNEL`

Local dry run:

```bash
echo '{"event":"workflow:complete","timestamp":"2026-04-09T00:00:00.000Z","runId":"run-abc","payload":{"totalCostUsd":0.042}}' \
  | DRY_RUN=1 SLACK_BOT_TOKEN=dummy SLACK_CHANNEL=C01234ABCDE node dist/hooks/adapters/notify-slack.js
```

## Built-in adapter: Telegram

Configuration:

```json
{
  "hooks": [
    {
      "adapter": "telegram",
      "events": ["workflow:complete", "workflow:failed", "approval:requested"],
      "envFrom": {
        "TELEGRAM_BOT_TOKEN": "SLICE_TELEGRAM_BOT_TOKEN",
        "TELEGRAM_CHAT_ID": "SLICE_TELEGRAM_CHAT_ID"
      },
      "timeoutMs": 10000
    }
  ]
}
```

Required env vars for the adapter process:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Local dry run:

```bash
echo '{"event":"approval:requested","timestamp":"2026-04-09T00:00:00.000Z","runId":"run-abc","payload":{"phase":"plan","artifactPath":"/path/to/plan.md"}}' \
  | DRY_RUN=1 TELEGRAM_BOT_TOKEN=dummy TELEGRAM_CHAT_ID=-100123 node dist/hooks/adapters/notify-telegram.js
```

## Custom command hooks

You can still define arbitrary commands:

```json
{
  "hooks": [
    {
      "command": "node ./scripts/notify-discord.js",
      "events": ["workflow:failed"],
      "async": true,
      "envFrom": {
        "DISCORD_WEBHOOK_URL": "SLICE_DISCORD_WEBHOOK_URL"
      }
    }
  ]
}
```

## Legacy `messaging.*` removal

`messagingSchema` and all `messaging.*` config are removed.

If `messaging` is present in config, `slice` fails validation with a clear error.

Use `hooks[]` with `adapter` + `envFrom` instead. Tokens stay in env vars; config only stores env names.

## Validation checklist

- [ ] Hooks validate with exactly one of `command` or `adapter`
- [ ] `events` list is set for each hook
- [ ] `envFrom` maps only env names (no literal tokens in config)
- [ ] Adapter hooks run with `DRY_RUN=1`
- [ ] Global hooks execute before project hooks
- [ ] Matcher regex behaves as expected
- [ ] Hook failures are visible in logs and do not crash the workflow

## CLI smoke commands

`slice` includes smoke commands for validating bundled adapters with real credentials loaded from `.env` files:

```bash
slice smoke-slack --channel C01234ABCDE --env-file .env
slice smoke-telegram --chat-id -100123456789 --env-file .env
```

Expected `.env` keys:
- Slack: `SLACK_BOT_TOKEN`
- Telegram: `TELEGRAM_BOT_TOKEN`
