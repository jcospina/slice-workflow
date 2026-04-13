# slice

AI workflow orchestrator for automating large-scale development tasks using a slice-based methodology.

## What it does

`slice` breaks ambitious dev tasks (features, refactors, migrations) into vertical slices and executes them autonomously with AI agents, each in an isolated git worktree with a fresh context window.

```text
slice                         # Opens the TUI
slice resume --pr 123         # Resume from PR feedback
slice smoke-slack --channel C01234ABCDE
slice smoke-telegram --chat-id -100123456789

Workflow:
  1. RFC Draft        — Interactive agent conversation to clarify requirements
  2. Draft Polish     — Autonomous agent refines the RFC against the codebase
  3. Plan             — Agent creates slices, tracks, and templates
  4. Execute Slices   — Sequential agents, each in its own worktree
  5. Handoff          — PR created with implementation notes
```

## The slice-based workflow

Each task is decomposed into small, independently executable slices. Every slice agent loads exactly **3 files** plus explores code:

- **Plan doc** — Goals, locked contracts, architecture (static)
- **PROGRESS.md** — Key decisions record (grows across slices, carries the WHY)
- **Current track file** — This slice's scope, definition of done, validation

Previous track files are never loaded by future agents — they exist as a human-readable audit trail in git. Code is the source of truth for WHAT; documents carry the WHY.

Each slice is small enough to fit within ~50% of an agent's context window, includes its own validation (tests, lint, type checks), and runs in an isolated git worktree so destructive operations never touch the main working copy.

## Architecture

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript / Node.js | Ecosystem fit, strong CLI tooling |
| Distribution | Global npm CLI | `npx slice` works anywhere |
| Primary runtime | Claude CLI (`claude -p` + `claude`) | CLI-first runtime for autonomous and interactive flows; usage/cost reporting may be unavailable |
| Secondary runtime | OpenCode SDK | 75+ models (OpenAI, Ollama, Gemini, local models), zero-cost local dev |
| TUI | Ink (React for CLI) | Component model, streaming output via `<Static>`, first-class TypeScript |
| Machine state | SQLite (`better-sqlite3`) | Atomic writes, queryable, crash-resilient, supports resumability |
| Human state | Filesystem (PROGRESS.md, tracks/) | Human-readable, agent-writable, git-trackable |
| Notifications | Lifecycle hooks (`hooks[]`) | Extensible command hooks; channel adapters can be added without orchestrator changes |
| Agent isolation | Git worktrees | Blast radius containment — agents never touch the main working copy |
| Post-slice review | Evaluator-optimizer loop | Reviewer agent checks changes against DoD, implementer fixes findings |

Notification delivery uses lifecycle hooks. See [docs/hooks.md](docs/hooks.md) for the full reference, bundled `slack`/`telegram` adapters, and `envFrom` secret mapping.

### Provider abstraction

The core `AgentRuntime` interface supports multiple AI backends:

- **Claude Code** — via the local `claude` CLI: `claude -p` for autonomous runs, `claude` with terminal handoff for interactive runs
- **OpenCode** — via `@opencode-ai/sdk`, supports 75+ model providers including local models through Ollama

For the `claude-code` runtime, `slice` expects the Claude CLI to already be installed, available on `PATH` (or configured through `providers.claudeCode.command`), and authenticated in the local shell environment before a run starts. `slice` does not install or log in to Claude on the user's behalf. Autonomous runs forward `AgentRunOptions.maxTurns` to Claude CLI `--max-turns` and `AgentRunOptions.allowedTools` to Claude CLI `--allowedTools` for approval-free tool execution. When the CLI cannot be launched, the runtime raises an explicit error instead of silently falling back. When the Claude CLI does not expose usage metadata, `AgentRunResult.costUsd` intentionally falls back to `0`.

For the `opencode` runtime, `slice` uses an SDK-first autonomous path (`@opencode-ai/sdk`) backed by a runtime-managed local `opencode serve` process on loopback (`127.0.0.1:4096`). The OpenCode CLI must already be installed and reachable on `PATH` (or configured through `providers.opencode.command`) before a run starts; `slice` does not install OpenCode. Interactive runs keep CLI terminal handoff (`opencode` with inherited stdio). Launch/startup failures (missing CLI, non-executable command, failed local server startup) are surfaced explicitly to operators; no silent fallback path is used. Hosted OpenCode offerings remain optional, and local provider setups are fully supported. When OpenCode usage metadata is unavailable, `AgentRunResult.costUsd` intentionally falls back to `0`.

### Approval gates

Approvals are channel-agnostic and return one `ApprovalResult` contract. Depending on your setup, they can come from:

- **TUI** — Local fallback / default path
- **Channel adapter** — Optional external integration wired via hooks

### Slice execution modes

- **Autonomous** (default) — All slices run start-to-end, lifecycle notifications are emitted via hooks
- **Gated** — Orchestrator pauses after each slice, waits for user approval via approval gateway (TUI and/or adapter)

## Configuration

**Global** (`~/.slice/config.json`):

```json
{
  "defaultProvider": "claude-code",
  "hooks": [
    {
      "adapter": "slack",
      "events": ["workflow:complete", "workflow:failed"],
      "envFrom": {
        "SLACK_BOT_TOKEN": "SLICE_SLACK_BOT_TOKEN",
        "SLACK_CHANNEL": "SLICE_SLACK_CHANNEL"
      }
    },
    {
      "adapter": "telegram",
      "events": ["slice:failed"],
      "envFrom": {
        "TELEGRAM_BOT_TOKEN": "SLICE_TELEGRAM_BOT_TOKEN",
        "TELEGRAM_CHAT_ID": "SLICE_TELEGRAM_CHAT_ID"
      }
    }
  ]
}
```

**Project** (`.slicerc`):

```json
{
  "provider": "claude-code",
  "sliceExecution": "autonomous",
  "review": { "enabled": true, "maxIterations": 2, "severityThreshold": "major" }
}
```

**Local models** (`.slicerc` for zero-cost testing with Ollama):

```json
{
  "provider": "opencode",
  "providers": { "opencode": { "model": "ollama/qwen2.5-coder:32b" } }
}
```

## Development

```bash
npm install
npm run build        # Build with tsup
npm run lint         # Biome check
npm run typecheck    # TypeScript strict mode
npm run test         # Vitest
npm run dev          # Watch mode
```

## Requirements

- Node.js >= 20
- `claude` CLI or `opencode` CLI installed (depending on chosen runtime)
- If using `claude-code`, the Claude CLI must already be authenticated in the local environment
- If using `opencode`, the OpenCode CLI must already be installed and runnable in the local environment
- `gh` CLI for PR creation and resume

## License

GPL-2.0 license
