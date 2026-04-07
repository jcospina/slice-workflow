# Slice 04 - App UI + Charts

## Scope
- Add user-facing income type controls, uncertainty badge behavior, and new cashflow charts.

## DoD
- Chat can display uncertainty badge using `has_uncertain_type`.
- Expense details dialog supports `expense` vs `income` editing.
- New grouped bar and cumulative savings charts are available with required toggles.
- Existing charts remain unchanged.

## Implementation Notes
- Income dialog fields: amount, date, source, note.
- Reuse existing chart window interactions (`1m`, `3m`, `6m`, `12m`).

## Key Decisions
- Keep existing expense chart panels behavior-compatible.
- Add new charts as separate visuals, not replacements.

## Touched Files
- To be filled during execution.

## Validations Run + Results
- Pending.

## Open Risks / Blockers
- Ensure chart labeling clearly differentiates monthly net vs cumulative savings semantics.
