# Plan: `slice` CLI — AI Workflow Orchestrator

## Context

The user has a proven "slice-based workflow" methodology for breaking large dev tasks into vertical slices executed by AI agents with fresh context windows. Two real implementations exist as references (decouple-data-layer, income-tracking). The goal is to build a CLI tool that automates the entire workflow: from requirement gathering through autonomous slice execution to PR creation and feedback handling.

## What We're Building

A TypeScript CLI tool called `slice`, installable via `npm install -g slice` / `npx slice`, that orchestrates this workflow:

```text
slice                         # Opens the terminal UI (TUI)
slice resume --pr 123         # Resume from PR feedback

TUI Flow:
    |
    +-- User writes initial prompt in a comfortable editor view
    +-- Phase 1: RFC Draft (interactive agent conversation)
    +-- Approval Gate (user reviews RFC via approval gateway: TUI and/or adapter channel)
    +-- Phase 2: Draft Polish (autonomous agent refines RFC)
    +-- Phase 3: Plan (interactive agent creates slices, tracks, templates; user refines until approved)
    +-- Approval Gate (user reviews plan via approval gateway: TUI and/or adapter channel)
    +-- Phase 4: Execute Slices (sequential agents, each in own worktree)
    |       +-- On merge conflict / error -> lifecycle hook notification + pause
    +-- Phase 5: Handoff (PR created with implementation notes)
    |       +-- lifecycle hook notification: PR ready for review
    +-- Progress tracked in TUI throughout (current phase, slice, cost)
```

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript/Node.js | Matches ecosystem, good CLI tooling |
| Distribution | Global npm CLI | `npx slice start` works anywhere |
| Primary runtime | Claude CLI (`claude -p` + `claude`) | CLI-first runtime: `claude -p` for autonomous phases and `claude` with `stdio: inherit` for interactive phases |
| Secondary runtime | OpenCode SDK (`@opencode-ai/sdk`) | Supports 75+ models (OpenAI, Ollama, Gemini, local models). Has its own battle-tested tool execution layer -- no need to build custom tools |
| Provider abstraction | `AgentRuntime` interface | Claude Code + OpenCode in v1, extensible to others |
| Execution | Local subprocesses | Direct filesystem access, run tests locally |
| Slice execution | Sequential (v1) | Simpler, parallel in v2 |
| Human state | Filesystem (PROGRESS.md, tracks/) | Human-readable, agent-writable, git-trackable |
| Machine state | SQLite via `better-sqlite3` at `.slice/slice.db` | Atomic writes, queryable, supports resumability, concurrent access safe for v2 parallelism |
| Terminal UI | Ink (React for CLI) | React component model, `<Static>` for streaming agent output, first-class TypeScript. Claude Code itself uses Ink. Requires Node >= 22, React >= 19 |
| Slice execution mode | `sliceExecution: 'autonomous' \| 'gated'` | Users choose whether slices run start-to-end or pause for approval after each slice |
| Agent isolation | Git worktrees (orchestrator-managed) | Safety mechanism: each agent works in a worktree so destructive operations never touch the main working copy |
| Post-slice review | Evaluator-optimizer loop | Separate reviewer agent checks changes against DoD, implementer fixes findings. Max iterations configurable |
| Framework | Custom orchestration | Existing agent SDKs are meant for API-calling agents, not subprocess-based coding agents. |
| Approval gates | Approval gateway + TUI fallback | Unified `ApprovalResult`; channel adapters are optional and can be swapped without orchestrator changes |
| Notifications | Lifecycle hook runner (`hooks[]`) | Extensible command hooks (Slack/Telegram/Discord/webhooks/custom scripts) without hardcoding channels in core |
| PR feedback | GitHub Action on "Changes Requested" -> posts `slice resume --pr N` | Automated trigger, manual execution |
| RFC phase | Interactive terminal (spawn `claude` or `opencode` with `stdio: inherit`) | Full agent UX for conversations |
| Config | `.slicerc` (project) + `~/.slice/config.json` (global) | Per-project customization |
| Git operations | Delegated to agents (within worktrees) | Agents handle branching, committing, and PR creation via their built-in bash/git tools. Orchestrator manages worktree lifecycle and verifies state |
| Agent permissions | Runtime-specific local execution config | Claude CLI runs in the isolated worktree and should avoid blocking prompts during autonomous phases. OpenCode autonomous runs use SDK permission event auto-response (`once`) to avoid approval blocking |

## Authentication & Provider Model

**Claude Code runtime**: Uses the locally installed `claude` CLI. Autonomous phases run via `claude -p`; interactive phases spawn `claude` with `stdio: inherit`. The CLI must already be installed, reachable on `PATH` (or via the configured command override), and authenticated before `slice` launches it. `slice` does not perform Claude installation or login flows. Usage/cost data may be unavailable for some CLI flows, so `AgentRunResult.costUsd` may legitimately be `0`.

**OpenCode runtime**: Uses an SDK-first autonomous path (`@opencode-ai/sdk`) against a runtime-managed local `opencode serve` process on loopback (`127.0.0.1:4096`), plus CLI terminal handoff (`opencode` with `stdio: inherit`) for interactive phases. The OpenCode CLI must already be installed and reachable on `PATH` (or configured command override) before launch; `slice` does not install OpenCode or run account setup flows. Launch/startup failures are surfaced explicitly (missing command, non-executable command, server startup timeout/exit) with no silent fallback path. Hosted OpenCode offerings are optional; local provider setups are valid and in-scope. When usage metadata is unavailable, `AgentRunResult.costUsd` intentionally falls back to `0`. OpenCode natively supports 75+ model providers, including:

- **OpenAI**: GPT-4o, etc.
- **Anthropic**: Claude models (alternative to the Claude CLI-first runtime)
- **Local models**: Ollama, LM Studio, llama.cpp
- **Cloud providers**: Groq, Together, AWS Bedrock, Azure OpenAI, Google Gemini, OpenRouter

This means all development/testing can run against local models at zero cost via OpenCode.

## Project Structure

```text
slice/
+-- package.json
+-- tsconfig.json
+-- vitest.config.ts
+-- biome.json
+-- bin/
|   +-- slice.ts                         # CLI entrypoint (hashbang)
+-- src/
|   +-- cli/
|   |   +-- index.ts                     # Commander setup, default command opens TUI
|   |   +-- commands/
|   |   |   +-- resume.ts               # slice resume --pr N
|   |   |   +-- setup-github.ts         # slice setup-github
|   |   +-- tui/                         # Terminal UI (Ink — React for CLI)
|   |   |   +-- index.ts                # Ink render() entrypoint
|   |   |   +-- app.tsx                 # Root React component
|   |   |   +-- views/                  # TUI screens (prompt editor, progress, approvals)
|   |   |   +-- components/             # Reusable Ink components
|   |   +-- ui/
|   |       +-- terminal.ts             # Colors, spinners, formatting (shared utils)
|   |       +-- approval-gate.ts        # Approve/feedback/reject (TUI + optional adapter channel)
|   |
|   +-- config/
|   |   +-- index.ts                    # Load & merge global + project config
|   |   +-- schema.ts                   # Zod validation schemas
|   |   +-- types.ts                    # SliceConfig, GlobalConfig, ProjectConfig
|   |
|   +-- orchestrator/
|   |   +-- index.ts                    # WorkflowOrchestrator -- main engine
|   |   +-- phases/
|   |   |   +-- types.ts               # Phase, PhaseResult, PhaseContext
|   |   |   +-- rfc-draft.ts           # Interactive RFC generation
|   |   |   +-- draft-polish.ts        # Autonomous RFC refinement
|   |   |   +-- plan.ts               # Slice plan generation
|   |   |   +-- execute.ts            # Sequential slice execution loop
|   |   |   +-- handoff.ts            # PR creation
|   |   |   +-- review.ts            # Post-slice review loop (evaluator-optimizer)
|   |   +-- state-machine.ts          # Phase transitions
|   |   +-- worktree.ts              # WorktreeManager — create, setup, cleanup worktrees
|   |
|   +-- runtime/
|   |   +-- types.ts                   # AgentRuntime interface (THE core abstraction)
|   |   +-- claude-code/
|   |   |   +-- index.ts              # ClaudeCodeRuntime (via local claude CLI)
|   |   |   +-- utils.ts              # Claude CLI argument/process helpers
|   |   +-- opencode.ts               # OpenCodeRuntime (via @opencode-ai/sdk)
|   |   +-- factory.ts                # Runtime factory
|   |   +-- slice-context.ts          # SliceExecutionContext typed contract (read-only fields per slice)
|   |
|   +-- prompts/
|   |   +-- index.ts                  # Prompt builder
|   |   +-- templates/
|   |   |   +-- rfc-draft.ts          # RFC system prompt
|   |   |   +-- draft-polish.ts       # Polish prompt
|   |   |   +-- plan.ts              # Plan prompt (includes sample structure)
|   |   |   +-- slice-execution.ts    # Per-slice prompt template
|   |   |   +-- slice-review.ts      # Reviewer agent prompt (scoped to DoD)
|   |   |   +-- slice-fix.ts         # Fix agent prompt (review findings)
|   |   |   +-- handoff.ts           # PR/handoff prompt
|   |   +-- context.ts               # Assembles context files into prompt blocks
|   |
|   +-- state/
|   |   +-- index.ts                 # StateManager
|   |   +-- db.ts                    # SQLite store (.slice/slice.db)
|   |   +-- migrations.ts            # DB schema migrations
|   |   +-- types.ts                 # WorkflowRun, PhaseRecord, SliceRecord
|   |
|   +-- messaging/                   # Legacy approval path during migration to hook-first notifications
|   |
|   +-- github/
|   |   +-- action.ts                # GitHub Action YAML generator
|   |   +-- resume-context.ts        # Fetch PR review context via gh
|   |
|   +-- hooks/
|   |   +-- types.ts                 # HookEvent, HookInput, HookOutput, HookDefinition
|   |   +-- runner.ts                # Hook execution engine (spawn, stdin JSON, abort support)
|   +-- diagnostics/
|   |   +-- tracker.ts               # Pre/post slice diagnostic capture and delta (tsc, lint, tests)
|   +-- utils/
|       +-- logger.ts
|       +-- errors.ts
|       +-- retry.ts                 # withRetry() with exponential backoff + RetryConfig
|       +-- fs.ts
|
+-- templates/
|   +-- github-action.yml            # PR feedback GH Action template
|
+-- test/
    +-- unit/
    +-- integration/
```

## Core Interface: AgentRuntime

This is the provider abstraction -- the most important interface in the codebase:

```typescript
interface AgentRuntime {
  run(options: AgentRunOptions): Promise<AgentRunResult>;
  runInteractive(options: AgentInteractiveOptions): Promise<AgentRunResult>;
  readonly provider: string;  // 'claude-code' | 'opencode'
}

interface AgentRunOptions {
  prompt: string;
  systemPrompt?: string;
  cwd: string;                    // Working directory
  contextFiles?: string[];        // Files agent reads first
  maxTurns?: number;
  allowedTools?: string[];
  onProgress?: (event: ProgressEvent) => void;
}

interface AgentRunResult {
  success: boolean;
  output: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  error?: string;
}
```

**ClaudeCodeRuntime**: Uses `claude -p` for autonomous phases and forwards `maxTurns` via `--max-turns` plus approval-free `allowedTools` via `--allowedTools` when provided. Spawns `claude` with `stdio: inherit` for the interactive RFC phase. If the local CLI is missing or cannot be launched, the runtime surfaces an explicit launch error instead of falling back. `costUsd` may be `0` when the Claude CLI does not expose usage data.

**OpenCodeRuntime**: Uses `@opencode-ai/sdk` for autonomous runs against a runtime-managed local `opencode serve` instance (HTTP on loopback port 4096), including permission auto-response to avoid approval blocking. For interactive RFC phase, spawns `opencode` with `stdio: inherit`. Missing CLI, launch, and local server startup failures are surfaced explicitly to operators instead of falling back silently. `costUsd` defaults to `0` when usage metadata is unavailable.

## Key Implementation Details

### Context Management Strategy

Each slice agent loads exactly 3 documents + explores code:

1. **Plan doc** (`{slug}.md`) -- Goals, locked contracts, architecture. Static, set once.
2. **PROGRESS.md** -- Key decisions record that grows naturally across slices. Captures the WHY behind choices. Not capped -- grows with signal, not noise.
3. **Current track file** (`tracks/NN-*.md`) -- This slice's scope, DoD, validation. Lean.
4. **Code** -- The agent explores the codebase to understand what exists. Code is the source of truth for WHAT was built.

Previous track files are **never loaded by future agents**. They exist as a human-readable audit trail in git.

This keeps agent context overhead constant regardless of how many slices have completed, while preserving full auditability for humans.

### Track File Structure

Track files serve two audiences: **agents** (pre-execution sections) and **humans** (post-execution sections).

**Pre-execution (agent-facing, pre-filled by Plan phase):**

- **Scope** -- What this slice touches (1-3 sentences)
- **Likely Call Sites** -- Specific files/paths expected to be modified
- **DoD (Definition of Done)** -- What success looks like for this slice
- **Validation** -- What commands/checks to run for this slice
- **Notes** -- Implementation guidelines or constraints specific to this slice

**Post-execution (human-facing audit trail, filled during execution):**

- **What Was Implemented** -- Detailed bullet list of what was done
- **Key Decisions** -- Reasoning and trade-offs made during implementation
- **Open Risks / Blockers** -- Known issues, deferred work, or dependencies on other slices

Dropped from track files (derivable from git/CI, adds noise that can mislead agents):
- ~~Touched Files~~ -- Use `git diff` or `git log`
- ~~Validations Run + Results~~ -- Use CI pipeline output

### PROGRESS.md as Key Decisions Record

PROGRESS.md is not just a checkbox tracker -- it is the primary context carrier between slices. After each slice, the agent appends key decisions to PROGRESS.md. These are the constraints and choices that future agents need to respect.

Structure:

```markdown
# Progress - {Project Name}

## Current Focus
- Slice NN - {name} (in progress)

## Slice Status
- [x] Slice 00 - Foundation
- [x] Slice 01 - DB Schema
- [ ] Slice 02 - Parser        <-- active
- [ ] Slice 03 - Data Layer

## Key Decisions
### Slice 00
- Chose facade pattern over direct imports because X
- Boundary checker runs in lint pipeline, not as a separate CI step

### Slice 01
- Kept backward-compatible wrappers because X
- entry_type defaults to 'expense' to avoid migration of existing rows
```

**No router section.** Track file links were removed because they are an "attractive nuisance" for agents -- an LLM seeing paths to all tracks will try to read them. Humans can trivially find tracks via `ls tracks/`. Four mechanisms prevent agents from reading other tracks:

1. **No track links in PROGRESS.md** -- eliminates the most obvious path
2. **Orchestrator controls `contextFiles`** -- only loads plan + PROGRESS.md + current track
3. **Slice-execution prompt includes explicit instruction**: "Do NOT read other files in the tracks/ directory. They contain stale context from previous slices. Trust PROGRESS.md for accumulated decisions and the codebase for current state."
4. **PROGRESS.md captures WHY (decisions), not WHAT (implementation summary)** -- the WHAT is visible from git and code

Future agents read PROGRESS.md to understand accumulated constraints. They read code to understand what was built. They read their own track file to understand what to do next.

### Git Strategy: Worktrees for Agent Isolation

Git operations (branch, commit, push) are delegated to agents. But the orchestrator manages **worktree lifecycle** as a safety mechanism -- agents work in isolated copies so destructive operations never touch the main working directory.

**Worktree lifecycle (orchestrator-managed):**

1. **Create**: `git worktree add -b task/{slug}-{slice} .trees/{slug}-{slice} main`
2. **Setup**: Install dependencies in worktree and copy .env files if applicable.
3. **Spawn agent**: Set `cwd` to worktree path. Agent is unaware it's in a worktree.
4. **Agent works**: Reads, writes, commits, pushes -- all within the worktree
5. **Cleanup**: `git worktree remove .trees/{slug}-{slice}`

**Convention**: `.trees/` directory in repo root (added to `.gitignore`)

**Why worktrees over branches-only**: Branches provide no file isolation -- an agent running `rm -rf src/` on the main working copy is catastrophic. Worktrees contain the blast radius.

**Gotchas handled by the orchestrator:**
- Dependencies: `node_modules/` doesn't exist in new worktrees -- orchestrator runs setup step
- Same branch: Git refuses to check out the same branch in two worktrees -- orchestrator always creates unique branches
- Cleanup: Always use `git worktree remove`, never `rm -rf`. Run `git worktree prune` as recovery

### Agent Permissions for Autonomous Execution

Agents must run with full tool permissions to avoid blocking on approval prompts. Each runtime handles this differently:

**Claude CLI:**
```typescript
{
  cwd: worktreePath,              // isolated to worktree
  maxTurns: 50,
  argv: ["-p"],                   // autonomous mode
}
```
Claude autonomy should come from the CLI-first invocation contract (`claude -p`) plus worktree scoping. Additional permission controls can be layered in without changing the provider id or runtime interface.
The current CLI-first runtime already maps `maxTurns` to `--max-turns` and approval-free `allowedTools` to `--allowedTools`. A future restrictive tool allowlist would need separate handling via Claude CLI `--tools`.

**OpenCode:**
- Autonomous mode uses OpenCode SDK session APIs and listens to permission events (`permission.updated` / `permission.asked`) to auto-respond with `"once"` for the active session.
- The runtime manages a local `opencode serve` process and fails fast with explicit startup errors when the CLI is missing, non-executable, exits early, or times out before readiness.

### Post-Slice Review Loop

After each slice, an optional **reviewer agent** evaluates the changes against the slice's DoD. If issues are found, a new implementer agent receives the findings and fixes them. This follows the evaluator-optimizer pattern.

```text
Implementer Agent (slice N)
    |
    v
[changes committed in worktree]
    |
    v
Reviewer Agent (iteration 1)
    |-- verdict: PASS --> continue to slice N+1
    |-- verdict: FAIL + findings -->
            |
            v
        Implementer Agent (fix iteration 1)
            |
            v
        Reviewer Agent (iteration 2)
            |-- PASS --> continue
            |-- FAIL --> max iterations reached, escalate to human
```

**Reviewer input (scoped to prevent nitpicking):**
- `git diff <before-sha>..<after-sha> -U10` -- only what changed
- Current track file (DoD is the review rubric)
- Plan doc excerpt (locked contracts, architecture constraints)
- NOT PROGRESS.md, NOT previous tracks

**Reviewer output (structured JSON):**
```typescript
interface ReviewResult {
  verdict: 'PASS' | 'FAIL' | 'PARTIAL';
  confidence: number;           // 0.0-1.0
  findings: ReviewFinding[];
  summary: string;
}

interface ReviewFinding {
  severity: 'critical' | 'major' | 'minor';
  file: string;
  lineRange: [number, number];
  title: string;
  body: string;
  dodItem: string;              // which DoD item this relates to
}
```

**Anti-nitpick mechanisms:**
- Reviewer prompt scoped to DoD items only, not general "code quality"
- Only `critical` and `major` findings trigger fix iterations. `minor` findings logged but don't loop
- Explicit instruction: "Only flag issues INTRODUCED by this diff. Do not flag pre-existing problems."
- Optionally use a different (cheaper) model for review via `reviewProvider` config

**Configuration:**
```typescript
review: {
  enabled: boolean;               // default: true
  maxIterations: number;          // default: 2
  reviewProvider?: string;        // optional: use different provider for review
  severityThreshold: 'critical' | 'major' | 'minor';  // default: 'major'
  adversarial: boolean;           // default: true — tries to break rather than confirm
}
```

Review results are stored in SQLite for auditability.

### Plan Phase Output Validation

The Plan agent must produce a specific folder structure. The orchestrator validates:

- `implementations/{slug}/{slug}.md` exists (main plan doc with goals, contracts, slice roadmap)
- `implementations/{slug}/PROGRESS.md` exists (with Key Decisions and Slice Status sections, no router)
- `implementations/{slug}/tracks/` directory with track files matching the slice count
- Each track file has at minimum: Scope and DoD sections pre-filled
- Optionally: `implementations/{slug}/templates/` with execution checklists

If validation fails, the agent is re-invoked with specific feedback about what's missing.

### Prompt Construction

Each phase builds prompts from 3 layers:

1. **System prompt** -- Role, constraints, output format (TypeScript template functions in `src/prompts/templates/`)
2. **Context block** -- Dynamically assembled from exactly 3 files: plan doc, PROGRESS.md, current track file. No previous track files loaded.
3. **Task prompt** -- Specific instruction for this invocation

The agent is expected to explore the codebase itself to understand what exists. The context files provide the WHY (decisions) and the WHAT TO DO (scope, DoD). The code provides the WHAT EXISTS.

The Plan phase includes the two sample implementations (decouple-data-layer, income-tracking) bundled with the package as reference patterns.

### Terminal UI (TUI) — Ink

The default `slice` command (no arguments) opens a terminal UI built with **Ink** (React renderer for terminals). The TUI is the primary interface for:

- **Prompt writing** -- A comfortable editor view for writing the initial task description (not cramped into a CLI arg). Supports multi-line editing via `ink-text-input`.
- **Progress tracking** -- Live view of: current phase, current slice, elapsed time, cost so far. Updated in real-time via React state. Agent output streamed using Ink's `<Static>` component (renders permanently above the interactive UI, avoids re-render thrashing).
- **Local approvals** -- When an approval gate is reached and no external adapter channel is configured, the TUI shows the artifact and approval controls inline via `ink-select-input`.
- **Workflow status** -- Overview of all active/completed workflows.

The TUI delegates to Claude Code / OpenCode for agent interactions (those tools have their own UIs). The TUI is the orchestration dashboard, not an agent interface.

**Key Ink components:**
- `<Box>` -- Flexbox layout (Yoga engine, same as React Native)
- `<Text>` -- Styled text (via chalk)
- `<Static>` -- Permanent output above interactive UI (critical for streaming agent logs)
- `ink-text-input` -- Text input with cursor
- `ink-select-input` -- Arrow-key selectable lists (approval gates, menu)
- `ink-spinner` -- Animated spinners (autonomous phase progress)
- `fullscreen-ink` -- Alternate screen buffer for full TUI experience

**Constraints:** Node >= 22, React >= 19, no native scrolling (manual or community package), Flexbox-only layout (no CSS Grid).

### Hook-based Notification Integration

Status (April 8, 2026): Phase D has been refocused to a hook-first notification architecture. The legacy hardcoded Slack/Telegram notification path is being replaced.

**Core model:**
- Orchestrator emits lifecycle events to `src/hooks/runner.ts`.
- Hooks are configured in global and project config (`hooks[]`), merged deterministically (project appends to global).
- Each hook receives JSON payload on stdin and can return structured JSON on stdout.
- Failures are non-blocking by default for notifications, with execution logged for auditability.

**Lifecycle events (planned contract):**
- `workflow:start`, `workflow:complete`, `workflow:failed`
- `phase:start`, `phase:complete`, `phase:failed`
- `slice:start`, `slice:complete`, `slice:failed`
- `review:start`, `review:verdict`
- `approval:requested`, `approval:received`

**Channel integrations:**
- Slack/Telegram are adapter commands invoked by hooks, not hardcoded orchestrator channels.
- The same model supports Discord, email, generic webhooks, or custom scripts without core changes.

**Approval behavior:**
- Approval remains channel-agnostic and returns one `ApprovalResult` contract.
- TUI remains the default fallback path.
- Optional adapter-backed channels may be used; first valid response wins.

**Slice execution modes:**
- `"autonomous"` (default): slices run start-to-end; lifecycle notifications are emitted as hook events.
- `"gated"`: after each slice, orchestrator pauses for approval; on crash during wait, SQLite preserves `awaiting_approval` state for resume.

### GitHub Action Flow

1. User installs GH Action via `slice setup-github` (copies `templates/github-action.yml` -> `.github/workflows/slice-feedback.yml`)
2. When a reviewer submits "Changes Requested" on a PR -> Action fires
3. Action collects review comments + diff context via GitHub API
4. Posts a comment: `slice resume --pr 123`
5. User runs the command locally -> spawns agent with review context + implementation folder

### State Management

Two layers of state serving different purposes:

**Human state** (filesystem -- agents read/write these):
- `PROGRESS.md` -- Key decisions record with slice checkboxes (no router)
- `tracks/*.md` -- Per-slice documentation with scope, decisions, results
- These live in `implementations/{slug}/` and are git-tracked

**Machine state** (SQLite at `.slice/slice.db` -- orchestrator reads/writes this):
- Workflow runs: ID, task description, slug, status, current phase, base/working branch
- Phase records: phase name, status, start/end timestamps, agent session ID, cost, duration, errors
- Slice records: index, name, status (pending/running/completed/failed/awaiting_approval), agent session ID, timestamps, cost, errors
- Review results: run ID, slice index, iteration, verdict, confidence, findings (JSON), reviewer session ID, cost
- Notification log: what was sent, when, to which channel, user response
- Resumability: on crash/restart, the orchestrator reads the DB to know exactly where it left off

SQLite over JSON because:
- Atomic writes (no partial state on crash)
- Queryable (e.g., "total cost across all slices", "which slices failed")
- Concurrent-access safe (needed when v2 adds parallel slice execution)
- Migrations support (schema can evolve with the tool)

The DB file is gitignored. It's machine-local state, not project documentation.

### Configuration

**Global** (`~/.slice/config.json`):

```json
{
  "defaultProvider": "claude-code",
  "providers": {
    "claudeCode": {
      "model": "sonnet"
    },
    "opencode": {
      "model": "anthropic/claude-sonnet-4-20250514"
    }
  },
  "hooks": [
    {
      "command": "node ./scripts/notify-slack.js",
      "events": ["workflow:complete", "workflow:failed"]
    },
    {
      "command": "node ./scripts/notify-telegram.js",
      "events": ["slice:failed", "review:verdict"]
    }
  ]
}
```

**Project** (`.slicerc`):

```json
{
  "implementationsDir": "implementations",
  "approvalGates": { "rfc": true, "plan": true },
  "sliceExecution": "autonomous",
  "provider": "claude-code",
  "review": {
    "enabled": true,
    "maxIterations": 2,
    "severityThreshold": "major",
    "adversarial": true
  },
  "execution": {
    "maxTurnsPerSlice": 50,
    "maxTurnsPerReview": 20
  },
  "retry": {
    "maxAttempts": 3,
    "baseDelayMs": 2000,
    "maxDelayMs": 60000
  },
  "hooks": [
    {
      "command": "linear-update --from-stdin",
      "events": ["workflow:complete", "workflow:failed"]
    }
  ]
}
```

**Local model example** (`.slicerc` for cost-free testing with OpenCode + Ollama):

```json
{
  "provider": "opencode",
  "providers": {
    "opencode": {
      "model": "ollama/qwen2.5-coder:32b"
    }
  }
}
```

## Implementation Order

### Phase A: Foundation

- Project scaffolding (package.json, tsconfig, biome, vitest, bin entrypoint)
- CLI framework with Commander.js -- default TUI command, `resume`, `setup-github`
- Configuration system with Zod validation (global + project config merge)
- SQLite state store with migrations (`.slice/slice.db`)
- Logger and error classes
- TUI skeleton with Ink: `render()` entrypoint, root `<App>` component, prompt editor view, basic layout with `<Box>`/`<Text>`

### Phase B: Runtime Layer

- `AgentRuntime` interface and types
- `ClaudeCodeRuntime` implementation:
  - `run()` via `claude -p`
  - `runInteractive()` via `child_process.spawn('claude', ..., { stdio: 'inherit' })`
  - Progress callbacks from process output when available
- `OpenCodeRuntime` implementation:
  - `run()` via `@opencode-ai/sdk` session + prompt
  - `runInteractive()` via `child_process.spawn('opencode', ..., { stdio: 'inherit' })`
  - Runtime-managed local `opencode serve` lifecycle for autonomous SDK calls
- Runtime factory (selects runtime based on config)
- Unit tests with mocked subprocess/CLI behavior

### Phase C: Orchestrator Core

- Phase state machine and transitions
- Prompt builder and template system
- RFC Draft phase (interactive spawn)
- Draft Polish phase (autonomous refinement)
- Plan phase (interactive, user refines until approved; validate output structure against track file schema)

### Phase D: Hook-Based Notifications

- Hook event model and config merge semantics (`global hooks + project hooks`)
- Hook runner: matcher routing, JSON stdin/stdout protocol, timeout and failure handling
- Async hook registry for long-running adapters
- Wire lifecycle hook emission into orchestrator transitions
- Slack/Telegram migration via hook adapters + docs and test matrix

### Phase E: Execution & Handoff

- WorktreeManager: create worktree, install deps, cleanup (`.trees/` convention)
- Slice execution loop: create worktree → spawn agent with `cwd` set to worktree → cleanup
- Agent permissions: Claude CLI-first autonomous execution in an isolated worktree, OpenCode autonomous SDK permission event auto-response (`once`)
- Post-slice review loop: reviewer agent → structured findings → fix agent → repeat (max N iterations)
- Adversarial reviewer prompt (PARTIAL verdict, anti-rationalization preamble, strategy matrix by change type, read-only /tmp constraint)
- `SliceExecutionContext` typed contract: build read-only context before each slice, inject write-boundary instructions into system prompt
- Diagnostic baseline/delta: capture tsc error count + lint issues + test pass rate before/after each slice; include delta in reviewer prompt
- Slice execution modes: autonomous (continue immediately) vs gated (pause for approval via gateway/TUI)
- Error handling: `RetryableError` + `BudgetExhaustedError` subclasses, `categorizeError()`, `withRetry()` wrapping slice execution
- Handoff phase (agent creates PR via `gh pr create`) + hook notification with PR URL

### Phase F: Resume & GitHub Action

- `slice resume --pr N` -- fetch review context via `gh api`, construct prompt, spawn agent
- GitHub Action template and `slice setup-github` command
- `slice status` -- read SQLite state, display progress table (include turns used/max for running slices)
- `slice config` -- interactive config management
- Session/CLI config overrides: `--provider`, `--model`, `--max-budget`, `--slice-execution`, `--no-review`, `--config` flags; resolve as in-memory session layer above project config

## Dependencies

### Production

| Package | Purpose |
|---------|---------|
| `commander` | CLI framework -- parses commands, flags, arguments, generates help text |
| `@opencode-ai/sdk` | OpenCode SDK -- programmatically controls OpenCode agents. Supports 75+ models with built-in tool execution (file edit, bash, grep, etc). No custom tool layer needed |
| `better-sqlite3` | SQLite driver -- synchronous, zero-config, single-file DB. Used for machine state (run history, phase records, slice records, resumability) |
| `zod` | Schema validation -- validates config files, agent structured outputs, plan phase output structure. Provides type inference from schemas |
| `ink` | React renderer for CLI -- builds the TUI. Flexbox layout via Yoga, `<Static>` for streaming output. Requires Node >= 22, React >= 19 |
| `react` | React 19 -- required by Ink. Hooks, state, context for TUI components |
| `ink-text-input` | Text input component for prompt editor |
| `ink-select-input` | Arrow-key selectable lists for approval gates, menus |
| `ink-spinner` | Animated spinners for autonomous phase progress |
| `chalk` | Terminal colors -- used by Ink's `<Text>` component for styling |
| `nanoid` | ID generation -- creates compact, URL-safe unique IDs for workflow runs, phase records, and slice records |

Optional channel adapter dependencies (project-specific, not core):
- `@slack/bolt` for a Slack adapter hook implementation
- `telegraf` for a Telegram adapter hook implementation

### Development

| Package | Purpose |
|---------|---------|
| `typescript` | TypeScript compiler |
| `tsup` | Build/bundler -- compiles TypeScript to JavaScript, bundles for npm distribution, handles ESM/CJS |
| `vitest` | Test framework -- fast, TypeScript-native, compatible with Jest API. Used for unit and integration tests |
| `@biomejs/biome` | Linting + formatting -- single tool replacing ESLint + Prettier. Configured with strictest rules |
| `@types/better-sqlite3` | TypeScript types for better-sqlite3 |
| `@types/react` | TypeScript types for React (required by Ink) |
| `ink-testing-library` | Testing utilities for Ink components -- render, inspect frames, simulate input |
| `husky` | Git hooks -- runs pre-commit checks (biome) |
| `lint-staged` | Staged file filtering -- runs biome only on staged files for fast pre-commit |

## Verification

1. **Unit tests**: Runtime (mocked CLI/subprocess behavior), config loader, SQLite state store, worktree manager, prompt builder, hook runner (matching/timeouts/parse failures), review loop (structured output parsing, early break, max iterations)
2. **Integration test**: Full workflow on a test repo -- creates RFC, plan, executes slice 0, creates PR
3. **Manual test**: Run against a real project with Claude Code, verify generated artifacts match decouple-data-layer/income-tracking structure
4. **Hook integration test**: Verify lifecycle events trigger configured hooks and adapter scripts receive expected JSON payloads
5. **Resume test**: Create a PR, submit "Changes Requested" review, run `slice resume`, verify agent receives review context
6. **TUI test**: Verify prompt editor, progress view, and local approval gates render and function correctly

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Agent produces plan in unexpected format | Validate structure post-plan (check track file sections), retry with specific feedback |
| Context window overflow on large slices | Plan prompt enforces 50% max fill, monitor via available CLI usage data when exposed; otherwise rely on duration/log output |
| `claude` or `opencode` CLI not installed | Check at startup, provide installation URL, suggest the other runtime as fallback |
| Hook command setup complexity | Provide `slice config` wizard and copy-paste adapter templates (Slack/Telegram/webhook) with documented payload schema |
| `gh` CLI not installed | Agents need `gh` for PR creation and resume. Check before handoff/resume phases, provide installation guidance |
| SQLite native dependency on npm install | `better-sqlite3` ships prebuilt binaries for all major platforms; fallback to build from source |
| Process crash mid-workflow | SQLite state survives crash, `slice status` shows where it stopped, `slice continue` resumes from last checkpoint |
| Notification payload too large for destination channel | Adapter layer handles truncation/chunking and uses file/document upload fallback when required by destination limits |
| Agent performs destructive operations | Worktree isolation contains blast radius -- main working copy is never touched |
| Review loop goes infinite | Hard cap via `review.maxIterations` (default 2). Only `critical`/`major` findings trigger fix iterations. Escalate to human on exhaustion |
| Worktree dependency setup slow | Use APFS copy-on-write clone (`cp -c`) for `node_modules` on macOS for near-instant duplication |
| Node < 22 users can't use TUI | Ink 6.x requires Node >= 22. Document requirement clearly. CLI commands (resume, status) degrade gracefully without TUI |
