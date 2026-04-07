# Progress Router - Income Tracking

## Source Plan
- Canonical plan: [income-tracking.md](./income-tracking.md)

## What Is Implemented So Far
- Implementation scaffold initialized.
- Canonical plan finalized with locked terminology/contracts for:
  - `entry_type`
  - `has_uncertain_type`
  - cumulative savings semantics
- Validation expectations clarified per slice (`00` through `05`).
- Progress router naming aligned with canonical slice names.
- Slice 01 schema primitives implemented:
  - `expenses.entry_type` (`expense|income`, non-null, default `expense`)
  - `chat_messages.has_uncertain_type` (non-null, default `false`)
- Existing expense analytics views updated with explicit expense-only filtering.
- New monthly cashflow views added (`income`, `expense`, `net`) plus scope/date/type indexes.
- Slice 01 DB validation flow executed (`db:reset`, `db:lint`, `db:schema:snapshot`).
- Slice 02 parser/processing/persistence implemented:
  - `+amount` parsed as strong income signal.
  - text fallback infers income when category scoring resolves to `income`.
  - parsed rows now persist `expenses.entry_type`.
  - `chat_messages.has_uncertain_type` is written during processing updates.
  - lifecycle preserved as `pending -> processed | needs_category | failed | no_expense`.
- Slice 02 targeted validations executed for parser, processor, and persistence helpers.
- Slice 02 income fallback dictionary extended with EN/ES income terms (`salario`, `salary`, `income`, `ingreso`, `bono`, `bonus`, `paycheck`) and validated.

## Current Focus
- Slice 03 - Data Layer + Stats APIs (ready to execute).

## Router (Use This To Keep Context Small)
- Foundation: [tracks/00-foundation.md](./tracks/00-foundation.md)
- DB Schema + Views: [tracks/01-db-schema-views.md](./tracks/01-db-schema-views.md)
- Parser + Processing + Persistence: [tracks/02-parser-processing-persistence.md](./tracks/02-parser-processing-persistence.md)
- Data Layer + Stats APIs: [tracks/03-data-layer-stats-apis.md](./tracks/03-data-layer-stats-apis.md)
- App UI + Charts: [tracks/04-app-ui-charts.md](./tracks/04-app-ui-charts.md)
- Consolidation: [tracks/05-consolidation.md](./tracks/05-consolidation.md)

## Update Rule
- Keep this file lean.
- Only update: `What Is Implemented So Far`, `Current Focus`, and completion checkboxes.
- Put implementation specifics in the corresponding track file.

## Slice Status
- [x] Slice 00 - Foundation
- [x] Slice 01 - DB Schema + Views
- [x] Slice 02 - Parser + Processing + Persistence
- [ ] Slice 03 - Data Layer + Stats APIs
- [ ] Slice 04 - App UI + Charts
- [ ] Slice 05 - Consolidation
