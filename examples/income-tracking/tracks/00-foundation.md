# Slice 00 - Foundation

## Scope
- Finalize execution guardrails for the income-tracking implementation package.
- Ensure slice naming, DoD language, and validation flow are consistent across files.

## DoD
- Plan, progress router, and track files are coherent and ready for incremental execution.
- Contract language is locked for `entry_type`, `has_uncertain_type`, and cumulative savings semantics.
- No app code, migration SQL, or behavior changes.

## What Was Implemented
- Updated the canonical plan to explicitly lock contract language for:
  - `expenses.entry_type`
  - `chat_messages.has_uncertain_type`
  - cumulative savings dataset semantics
- Added explicit per-slice validation expectations to reduce cross-slice ambiguity.
- Normalized slice naming/casing between the canonical plan and progress router.
- Marked Slice 00 as complete and set Slice 01 as current focus.

## Key Decisions
- Preserve existing chat status lifecycle.
- Use a minimal message-level uncertainty signal (`has_uncertain_type`) instead of adding new status enums.
- Define cumulative savings as a running monthly sum of net cashflow `(income - expense)` within the selected window and scope.
- Keep Slice 00 strictly docs/checklist/contracts focused (no schema/code behavior changes).

## Touched Files
- `.internal/implementations/income-tracking/income-tracking.md`
- `.internal/implementations/income-tracking/PROGRESS.md`
- `.internal/implementations/income-tracking/tracks/00-foundation.md`

## Validations Run + Results
- `PROGRESS.md` router link resolution check: pass (all linked track files and canonical plan file resolve).
- Slice naming/status consistency check (`income-tracking.md` vs `PROGRESS.md`): pass.
- Manual review for scope boundary: pass (Slice 00 changes are documentation-only; no SQL/runtime code touched).

## Open Risks / Blockers
- None.
