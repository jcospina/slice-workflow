# Slice 5 - Consolidation

## Scope
- Complete boundary enforcement and cleanup.

## DoD
- Migrated UI layers consume facades only.
- Remaining direct transport imports are explicit and documented.

## What Was Implemented
- Replaced direct helper reads in migrated server pages with facade reads:
  - `@helpers/user` -> `@/lib/data/auth/server` (`getCurrentUser`)
  - `@helpers/user-prefs` -> `@/lib/data/prefs/server` (`getUserPreferences`)
- Strengthened `scripts/check-data-boundaries.mjs` for migrated scopes to fail on:
  - alias imports from transport layers (`@helpers/*`, `@actions/*`, `@lib-supabase/*`, `@/lib/{helpers,actions,supabase}/*`)
  - relative imports resolving into `src/lib/{helpers,actions,supabase}/`
  - raw `fetch('/api/*')` with single quote, double quote, or template literal
- Verified migrated scope paths contain no remaining direct transport imports.
- Remaining intentional direct transport imports in migrated scopes: none.

## Key Decisions
- Enforced stricter migrated-scope import rules in the existing Slice 0 boundary checker instead of adding a new checker to keep guardrails centralized.
- Preserved behavior by routing through existing facade wrappers (which already preserve `payload + optional errorCode` contracts and helper/action internals).

## Touched Files
- `scripts/check-data-boundaries.mjs`
- `src/app/onboarding/page.tsx`
- `src/app/home/layout.tsx`
- `src/app/home/profile/page.tsx`
- `src/app/home/stats/page.tsx`
- `src/app/home/page.tsx`
- `implementations/decouple-data-layer/PROGRESS.md`
- `implementations/decouple-data-layer/tracks/05-consolidation.md`

## Validations Run + Results
- `pnpm test src/lib/data/auth/server.test.ts src/lib/data/prefs/server.test.ts src/lib/data/stats/server.test.ts` -> pass (3 suites, 12 tests).
- `pnpm lint` -> pass; boundary checks passed. One pre-existing ESLint warning remains in `src/components/charts/ring-chart.tsx` (`react-hooks/exhaustive-deps`).
- `pnpm format:check` -> fail due pre-existing unrelated files:
  - `.claude/settings.local.json`
  - `skills/momo-ui-builder/agents/openai.yaml`

## Open Risks / Blockers
- `pnpm format:check` is currently blocked by unrelated pre-existing formatting issues listed above.
