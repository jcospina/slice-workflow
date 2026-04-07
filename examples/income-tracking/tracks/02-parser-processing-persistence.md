# Slice 02 - Parser + Processing + Persistence

## Scope
- Introduce typed parsing and persistence behavior for chat entries.
- Set message uncertainty badge signal during processing.

## DoD
- `+`-prefixed inputs parse as income.
- Text fallback detection for type works.
- Persisted rows include `entry_type`.
- `has_uncertain_type` is set correctly.
- Existing status lifecycle preserved.

## Implementation Notes
- Precedence: explicit `+` over inferred text.
- Keep expense category semantics intact (`needs_category` remains expense-related).
- Avoid introducing new chat status values.

## What Was Implemented
- Extended parser output with per-entry `entry_type` (`expense|income`) and `has_uncertain_type`.
- Implemented type classification precedence:
  - explicit `+amount` => income (certain)
  - text fallback (`scoreExpenseCategory(...)=income`) => income (uncertain)
  - no income signal => expense (certain)
- Updated normalization to preserve `+` so explicit income markers survive preprocessing.
- Extended income fallback dictionary coverage with requested EN/ES terms:
  - `salario`, `salary`, `income`, `ingreso`, `bono`, `bonus`, `paycheck`
- Persisted `entry_type` into inserted `expenses` rows.
- Updated chat message processing updates to write `has_uncertain_type` alongside status and expense count.
- Kept `needs_category` expense-only (income rows do not trigger `needs_category`).

## Key Decisions
- Type uncertainty represented as message-level boolean.
- Full inference details are runtime logic, not DB contract.
- Reused existing category-scoring output for text fallback inference to keep Slice 02 minimal and architecture-compatible.
- Treated fallback income detection as uncertain; explicit `+` remains the only certain income signal.
- Preserved lifecycle contract exactly: `pending -> processed | needs_category | failed | no_expense`.

## Touched Files
- `src/lib/helpers/expenses/expense-normalize.ts`
- `src/lib/helpers/expenses/expense-parser.ts`
- `src/lib/helpers/chat/chat-processor.ts`
- `src/lib/helpers/expenses/expense-persistence.ts`
- `src/lib/types/expenses.ts`
- `src/lib/helpers/expenses/expense-parser.test.ts`
- `src/lib/helpers/expenses/expense-persistence.test.ts`
- `src/lib/helpers/chat/chat-processor.test.ts`
- `src/lib/constants/expenses/dictionary.ts`
- `src/mocks/expense-classifier-samples.ts`
- `.internal/implementations/income-tracking/PROGRESS.md`
- `.internal/implementations/income-tracking/tracks/02-parser-processing-persistence.md`

## Validations Run + Results
- `pnpm test src/lib/helpers/expenses/expense-parser.test.ts src/lib/helpers/chat/chat-processor.test.ts src/lib/helpers/expenses/expense-persistence.test.ts`: pass (3 suites, 18 tests).
- Lifecycle path checks in targeted tests: pass (`no_expense`, `processed`, `needs_category`, plus failure-path fallback to `failed` in persistence tests).
- `pnpm test src/lib/helpers/expenses/expense-category.test.ts src/lib/helpers/expenses/expense-parser.test.ts`: pass (2 suites, 72 tests) after EN/ES income keyword extension.

## Open Risks / Blockers
- No blockers.
- Risk to monitor in later slices: fallback income inference quality depends on existing category dictionary coverage and may need tuning with production samples.
