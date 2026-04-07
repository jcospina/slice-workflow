# MoMo Income Tracking Plan (Sliced, DB-First)

## Goal
Add income tracking to the chat-first flow while preserving current chat lifecycle semantics and existing expense behavior.

Primary outcomes:
- Users can log income and expenses from chat with `+` support.
- Data model supports typed ledger entries (`expense` vs `income`).
- Stats include cashflow comparison and cumulative savings views.
- Delivery is sliced to keep risk low and context manageable.

## Locked Contracts and Decisions (Slice 00 Output)
- No historical backfill logic.
- Add `expenses.entry_type` with contract values `expense | income`.
- Keep chat status lifecycle unchanged: `pending -> processed | needs_category | failed | no_expense`.
- Add `chat_messages.has_uncertain_type` (`boolean`) for income/expense type uncertainty badge rendering.
- Type detection: explicit `+` wins; text inference is fallback.
- Cumulative savings is a running monthly sum of `(income - expense)` within the selected window and scope, ordered chronologically.
- Existing charts remain unchanged; add new cashflow charts separately.

## Contract Language Lock (for later slices)
- `entry_type`:
  - Column contract: `expenses.entry_type`.
  - Allowed values: `expense`, `income`.
  - Default behavior: default to `expense` when no income signal is present.
- `has_uncertain_type`:
  - Column contract: `chat_messages.has_uncertain_type`.
  - Meaning: `true` when at least one parsed entry in a message has uncertain income/expense classification.
  - Non-goal: does not replace chat status lifecycle and does not store full inference metadata.
- `cumulative savings`:
  - Dataset contract: chart line derived from monthly net cashflow.
  - Formula: running total of monthly `(income - expense)` points in time order for the selected window.
  - Non-goal: does not redefine existing expense-only charts.

## Sliced Roadmap (00-05)

### Slice 00 - Foundation
Goal:
- Lock contracts, naming, and checklist flow for this implementation package.

Definition of Done:
- Canonical plan + progress router + tracks exist and are aligned.
- Terminology contracts are explicitly locked (`entry_type`, `has_uncertain_type`, cumulative savings).
- Validation expectations are explicit for slices `01` through `05`.
- No app behavior changes.

### Slice 01 - DB Schema + Views
Goal:
- Introduce schema primitives and cashflow views.

Planned changes:
- Add `expenses.entry_type` (`expense`/`income`, default `expense`, non-null).
- Add `chat_messages.has_uncertain_type` (`boolean`, default `false`, non-null).
- Keep `chat_message_status` enum unchanged.
- Keep existing expense analytics stable by explicit expense-only filtering where needed.
- Add monthly cashflow views for `income`, `expense`, and `net`.
- Add indexes supporting scope/date/type chart queries.

Definition of Done:
- Migration created under `supabase/migrations`.
- Local migration replay and lint pass.

### Slice 02 - Parser + Processing + Persistence
Goal:
- Parse and persist typed entries and uncertainty signal.

Planned changes:
- Parse `+amount` as strong income signal.
- Apply text-based fallback for type detection.
- Persist `entry_type` on created rows.
- Set `chat_messages.has_uncertain_type=true` when any parsed entry type is uncertain.
- Preserve existing status transitions and expense category behavior.

Definition of Done:
- Typed persistence works for chat processing.
- Tests cover parse and persistence behavior.

### Slice 03 - Data Layer + Stats APIs
Goal:
- Expose new cashflow datasets through existing facade boundaries.

Planned changes:
- Add/extend action + facade methods for monthly income/expense bars and cumulative savings line.
- Support existing window toggles (`1m`, `3m`, `6m`, `12m`).
- Keep existing contracts backward compatible via additive fields/endpoints.

Definition of Done:
- Server/client facades return chart-ready data for new visuals.
- Existing stats callers remain unaffected.

### Slice 04 - App UI + Charts
Goal:
- Ship user-facing income controls and charts.

Planned changes:
- Chat badge for `has_uncertain_type`.
- Expense details dialog adds type selector.
- Income dialog variant fields: amount/date/source + note.
- Add monthly income-vs-expense grouped bars.
- Add cumulative savings line chart.
- Keep existing charts unchanged.

Definition of Done:
- New UI paths work in personal and household scopes.
- Existing expense flows remain stable.

### Slice 05 - Consolidation
Goal:
- Final parity checks, docs updates, and cleanup.

Planned changes:
- Regression pass across chat sync/realtime, parsing, and stats.
- Documentation updates for DB, expense parsing, and stats behavior.
- Final checklist and handoff notes.

Definition of Done:
- Validation suite complete and documented.
- Open risks and follow-ups clearly recorded.

## Validation Flow
### DB Migration validation
1. `pnpm db:reset`
2. `pnpm db:lint`
3. `pnpm db:schema:snapshot`
4. CI: `DB Migrations Check` workflow green

### Slice validation baseline
1. Targeted tests for touched slice
2. `pnpm lint`
3. `pnpm format:check`
4. `pnpm test`

## Validation Expectations by Slice
- Slice 00:
  - Documentation consistency checks only.
  - Progress router links resolve to existing files.
  - Slice naming/status is consistent between plan and progress router.
- Slice 01:
  - Run DB migration validation flow.
  - Confirm existing expense analytics remain stable by explicit expense filtering where required.
- Slice 02:
  - Run targeted parser/processing/persistence tests.
  - Verify lifecycle remains `pending -> processed | needs_category | failed | no_expense`.
- Slice 03:
  - Run targeted data-layer/stats API validations for personal and household scopes.
  - Verify additive contract compatibility (`payload` + optional `errorCode`).
- Slice 04:
  - Run targeted UI validations for uncertainty badge, type editing, and new cashflow charts.
  - Verify existing expense visuals remain unchanged.
- Slice 05:
  - Run full validation baseline and final regression pass.
  - Record remaining risks/follow-ups in consolidation track.

## Assumptions
- Canonical implementation docs location: `.internal/implementations/income-tracking/`.
- This scaffold phase is docs-only; no migration SQL or feature code execution yet.
