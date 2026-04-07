# Slice 1 - Auth + Onboarding + Prefs

## Scope
- Move auth/onboarding/prefs call-sites to `src/lib/data/*` facades.
- Preserve current redirects and `errorCode` behavior.

## Likely Call Sites
- `src/app/login/page.tsx`
- `src/app/onboarding/page.tsx`
- `src/app/home/profile/page.tsx` (logout path)
- `src/app/home/profile/currency-select.tsx`
- `src/app/home/profile/language-select.tsx`
- `src/app/home/profile/ai-enabled.tsx`
- `src/app/auth/callback/route.ts` (onboarding status)

## DoD
- Migrated scope has no direct imports of `@actions/login`, `@actions/logout`, `@actions/user-prefs`.
- No style/layout regressions in touched pages.

## Validation
- Run targeted tests for touched paths.
- Then run `pnpm lint`, `pnpm format:check`, `pnpm test`.

## What Was Implemented
- Implemented facade APIs for:
  - `src/lib/data/auth/{server.ts,client.ts,types.ts}`
  - `src/lib/data/prefs/{server.ts,client.ts,types.ts}`
- Migrated Slice 1 auth/prefs call-sites to facades:
  - `src/app/login/page.tsx`
  - `src/app/onboarding/page.tsx`
  - `src/app/home/profile/page.tsx` (logout + prefs read)
  - `src/app/home/profile/currency-select.tsx`
  - `src/app/home/profile/language-select.tsx`
  - `src/app/home/profile/ai-enabled.tsx`
  - `src/app/auth/callback/route.ts`
- Added focused tests for new facade wrappers:
  - `src/lib/data/auth/server.test.ts`
  - `src/lib/data/prefs/server.test.ts`
  - `src/lib/data/prefs/client.test.ts`
- Added migrated UI paths for fully facade-safe Slice 1 files to `implementations/decouple-data-layer/migrated-ui-scopes.json`.

## Key Decisions
- Preserved redirect/action semantics by delegating facade methods to existing actions/helpers instead of reworking transport logic.
- Added `'use server'` inside facade methods used as `formAction` (`auth.server.loginWithProvider`, `auth.server.logout`, `prefs.server.setOnboardingStatus`) to keep server action behavior unchanged.
- Added only Slice 1 files that are currently free of direct transport imports to migrated scopes:
  - Included login/onboarding/profile settings client files.
  - Deferred `src/app/home/profile/page.tsx` and `src/app/auth/callback/route.ts` from migrated-scope enforcement because they still intentionally depend on non-Slice-1 transport imports (`@actions/households`, `@lib-supabase/server`) and would force cross-slice migration.

## Touched Files
- `src/lib/data/auth/types.ts`
- `src/lib/data/auth/server.ts`
- `src/lib/data/auth/client.ts`
- `src/lib/data/prefs/types.ts`
- `src/lib/data/prefs/server.ts`
- `src/lib/data/prefs/client.ts`
- `src/app/login/page.tsx`
- `src/app/onboarding/page.tsx`
- `src/app/home/profile/page.tsx`
- `src/app/home/profile/currency-select.tsx`
- `src/app/home/profile/language-select.tsx`
- `src/app/home/profile/ai-enabled.tsx`
- `src/app/auth/callback/route.ts`
- `src/lib/data/auth/server.test.ts`
- `src/lib/data/prefs/server.test.ts`
- `src/lib/data/prefs/client.test.ts`
- `implementations/decouple-data-layer/migrated-ui-scopes.json`

## Validations Run + Results
- `pnpm test -- src/lib/data/auth/server.test.ts src/lib/data/prefs/server.test.ts src/lib/data/prefs/client.test.ts`: pass (3 suites, 12 tests).
- `pnpm lint`: pass (1 pre-existing warning in `src/components/charts/ring-chart.tsx` about `react-hooks/exhaustive-deps`; boundary checks passed).
- `pnpm format:check`: fail due pre-existing unrelated formatting issues in:
  - `.claude/settings.local.json`
  - `skills/momo-ui-builder/agents/openai.yaml`

## Open Risks / Blockers
- `pnpm format:check` remains red because of pre-existing repository files outside Slice 1.
- `src/app/home/profile/page.tsx` and `src/app/auth/callback/route.ts` are migrated to auth/prefs facades for Slice 1 methods, but not yet listed under strict migrated-scope enforcement until Slice 2 transport dependencies are also moved.
