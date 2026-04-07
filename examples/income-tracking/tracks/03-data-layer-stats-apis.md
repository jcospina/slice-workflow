# Slice 03 - Data Layer + Stats APIs

## Scope
- Expose typed-ledger and cashflow datasets through data facades/actions.
- Keep existing API contracts backward compatible.

## DoD
- Additive data contracts support new cashflow charts.
- Existing stats consumers continue to function unchanged.

## Implementation Notes
- Add methods for:
  - Monthly income-vs-expense dataset.
  - Cumulative savings dataset over selected window.
- Respect existing facade boundaries (`src/lib/data/*`).

## Key Decisions
- Window toggles remain `1m`, `3m`, `6m`, `12m`.
- Existing charts and endpoints are not broken or repurposed.

## Touched Files
- To be filled during execution.

## Validations Run + Results
- Pending.

## Open Risks / Blockers
- Careful scope resolution (personal vs household) required for new aggregates.
