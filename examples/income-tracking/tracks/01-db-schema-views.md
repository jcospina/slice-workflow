# Slice 01 - DB Schema + Views

## Scope
- Add schema support for typed entries and message-level type uncertainty.
- Add/adjust SQL views for cashflow analytics while preserving existing expense charts.

## DoD
- Migration(s) created and replayable locally.
- SQL lint passes.
- Snapshot refresh completed.

## Implementation Notes
- Add `expenses.entry_type` with safe defaults.
- Add `chat_messages.has_uncertain_type boolean` for badge rendering.
- Keep `chat_message_status` enum unchanged.
- Ensure existing expense-only views remain behavior-compatible.
- Add monthly cashflow view(s): income, expense, net.

## What Was Implemented
- Added `expenses.entry_type text NOT NULL DEFAULT 'expense'` with `expenses_entry_type_check` (`expense|income`).
- Added `chat_messages.has_uncertain_type boolean NOT NULL DEFAULT false`.
- Kept `chat_message_status` enum unchanged.
- Updated existing expense analytics views to explicitly filter `entry_type = 'expense'`:
  - `daily_totals_by_month`
  - `monthly_by_category`
  - `monthly_by_category_user`
  - `monthly_totals`
  - `monthly_totals_by_user`
- Added cashflow views:
  - `monthly_cashflow_income`
  - `monthly_cashflow_expense`
  - `monthly_cashflow_net` (`income_cents`, `expense_cents`, `net_cents`)
- Added chart-supporting indexes:
  - `idx_expenses_household_entry_type_expense_date`
  - `idx_expenses_personal_user_entry_type_expense_date`
- Added grants for new cashflow views to `anon`, `authenticated`, and `service_role`.

## Key Decisions
- No historical backfill logic for income classification.
- No full inference metadata persisted in DB.
- Existing expense analytics were locked with explicit `entry_type='expense'` predicates to preserve current chart semantics as income rows are introduced.
- Cashflow datasets were introduced as additive views; no existing view contracts were repurposed.
- Migration filename was ordered after baseline to ensure replay safety.

## Touched Files
- `supabase/migrations/20260318170001_income_tracking_slice_01_db_schema_views.sql`
- `.internal/implementations/income-tracking/PROGRESS.md`
- `.internal/implementations/income-tracking/tracks/01-db-schema-views.md`

## Validations Run + Results
- `pnpm db:start`: pass (required to run local DB reset).
- `pnpm db:reset`: pass (baseline + Slice 01 migration applied in order).
- `pnpm db:lint`: pass (reported existing warning in `extensions.index_advisor`; no Slice 01 lint errors).
- `pnpm db:schema:snapshot`: pass (linked schema dump regenerated at `schema/momo_snapshot.sql`).
- Migration ordering verification: pass (`20260318162958_*` baseline runs before `20260318170001_*` Slice 01).
- Backward-compatibility verification: pass (existing expense analytics views remain expense-only via explicit predicates).
- Local contract check (`supabase db query --local`): pass (legacy view column sets unchanged; cashflow views present with expected columns).

## Open Risks / Blockers
- No blockers.
- Risk to track: linked snapshot reflects hosted DB state, so new Slice 01 objects appear there only after hosted migration apply.
