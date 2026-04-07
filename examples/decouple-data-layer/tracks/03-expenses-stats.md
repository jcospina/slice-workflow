# Slice 3 - Expenses + Stats

## Scope
- Migrate expenses and stats call-sites to facades.

## DoD
- Currency/amount invariants preserved.
- Stats payload shapes unchanged for chart components.

## Validation
- Verify stats and expense parity plus targeted tests.

## What Was Implemented
- Implemented facade APIs for:
  - `src/lib/data/expenses/{server.ts,client.ts,types.ts}`
  - `src/lib/data/stats/{server.ts,client.ts,types.ts}`
- Preserved existing Slice 3 behavior by keeping facades as thin wrappers over:
  - `@actions/expenses` (expense read/update)
  - `@actions/expense-stats` (all current stats exports)
- Migrated Slice 3 call-sites:
  - `src/components/expense-details/expense-details-dialog.tsx` -> `@/lib/data/expenses/client`
  - `src/app/home/stats/page.tsx` -> `@/lib/data/stats/server`
- Added focused facade tests:
  - `src/lib/data/expenses/server.test.ts`
  - `src/lib/data/expenses/client.test.ts`
  - `src/lib/data/stats/server.test.ts`
  - `src/lib/data/stats/client.test.ts`
- Added Slice 3 migrated UI paths to `implementations/decouple-data-layer/migrated-ui-scopes.json`.

## Key Decisions
- Kept `payload + optional errorCode` compatibility by delegating directly to existing actions instead of changing data/result contracts.
- Preserved currency invariants (`COP` whole units, `USD/EUR` minor units) by reusing current `updateExpenses` action logic unchanged.
- Preserved chart payload shape parity by exposing all existing `expense-stats` action methods through the `stats` facades.
- Added both server and client facade entrypoints for expenses/stats to keep environment-safe imports explicit and align with Slice 0 guardrails.

## Touched Files
- `src/lib/data/expenses/types.ts`
- `src/lib/data/expenses/server.ts`
- `src/lib/data/expenses/client.ts`
- `src/lib/data/stats/types.ts`
- `src/lib/data/stats/server.ts`
- `src/lib/data/stats/client.ts`
- `src/components/expense-details/expense-details-dialog.tsx`
- `src/app/home/stats/page.tsx`
- `src/lib/data/expenses/server.test.ts`
- `src/lib/data/expenses/client.test.ts`
- `src/lib/data/stats/server.test.ts`
- `src/lib/data/stats/client.test.ts`
- `implementations/decouple-data-layer/migrated-ui-scopes.json`
- `implementations/decouple-data-layer/PROGRESS.md`
- `implementations/decouple-data-layer/tracks/03-expenses-stats.md`

## Validations Run + Results
- `pnpm test -- src/lib/data/expenses/server.test.ts src/lib/data/expenses/client.test.ts src/lib/data/stats/server.test.ts src/lib/data/stats/client.test.ts src/lib/actions/expense-stats.test.ts`: pass (5 suites, 15 tests).
- `pnpm lint`: pass (data-boundary checks passed; 1 pre-existing warning in `src/components/charts/ring-chart.tsx`).
- `pnpm format:check`: fail due pre-existing unrelated formatting issues in:
  - `.claude/settings.local.json`
  - `skills/momo-ui-builder/agents/openai.yaml`

## Open Risks / Blockers
- `pnpm format:check` remains red because of pre-existing repository files outside Slice 3.
