# slice

AI workflow orchestrator for automating large-scale development tasks using a slice-based methodology.

## What it does

`slice` breaks ambitious dev tasks (features, refactors, migrations) into vertical slices and executes them autonomously with AI agents, each in an isolated git worktree with a fresh context window.

```text
slice                         # Opens the TUI
slice resume --pr 123         # Resume from PR feedback

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
| Notifications | Slack (Socket Mode) + Telegram (polling) | Bidirectional, no public URL needed, mobile-friendly approvals |
| Agent isolation | Git worktrees | Blast radius containment — agents never touch the main working copy |
| Post-slice review | Evaluator-optimizer loop | Reviewer agent checks changes against DoD, implementer fixes findings |

### Provider abstraction

The core `AgentRuntime` interface supports multiple AI backends:

- **Claude Code** — via the local `claude` CLI: `claude -p` for autonomous runs, `claude` with terminal handoff for interactive runs
- **OpenCode** — via `@opencode-ai/sdk`, supports 75+ model providers including local models through Ollama

For the `claude-code` runtime, `slice` expects the Claude CLI to already be installed, available on `PATH` (or configured through `providers.claudeCode.command`), and authenticated in the local shell environment before a run starts. `slice` does not install or log in to Claude on the user's behalf. Autonomous runs forward `AgentRunOptions.maxTurns` to Claude CLI `--max-turns` and `AgentRunOptions.allowedTools` to Claude CLI `--allowedTools` for approval-free tool execution. When the CLI cannot be launched, the runtime raises an explicit error instead of silently falling back. When the Claude CLI does not expose usage metadata, `AgentRunResult.costUsd` intentionally falls back to `0`.

For the `opencode` runtime, `slice` uses an SDK-first autonomous path (`@opencode-ai/sdk`) backed by a runtime-managed local `opencode serve` process on loopback (`127.0.0.1:4096`). The OpenCode CLI must already be installed and reachable on `PATH` (or configured through `providers.opencode.command`) before a run starts; `slice` does not install OpenCode. Interactive runs keep CLI terminal handoff (`opencode` with inherited stdio). Launch/startup failures (missing CLI, non-executable command, failed local server startup) are surfaced explicitly to operators; no silent fallback path is used. Hosted OpenCode offerings remain optional, and local provider setups are fully supported. When OpenCode usage metadata is unavailable, `AgentRunResult.costUsd` intentionally falls back to `0`.

### Approval gates

Users can approve, reject, or request changes on RFCs and plans from:

- **Slack** — Interactive buttons and modals via Socket Mode
- **Telegram** — Inline keyboards via long polling
- **TUI** — Local fallback when no messaging is configured

### Slice execution modes

- **Autonomous** (default) — All slices run start-to-end, notifications are informational
- **Gated** — Orchestrator pauses after each slice, waits for user approval via messaging or TUI

## Configuration

**Global** (`~/.slice/config.json`):

```json
{
  "defaultProvider": "claude-code",
  "messaging": {
    "slack": { "appToken": "xapp-...", "botToken": "xoxb-...", "defaultChannel": "#slice-notifications" },
    "telegram": { "botToken": "123456:ABC-DEF...", "chatId": "-1001234567890" }
  }
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
