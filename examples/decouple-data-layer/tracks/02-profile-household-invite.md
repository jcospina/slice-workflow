# Slice 2 - Profile + Household + Invite

## Scope
- Migrate profile/household/invite data access to facades.

## DoD
- Migrated scope no longer calls helpers/actions directly.
- Invite acceptance and onboarding continuation behavior unchanged.

## Validation
- Smoke-check profile and invite flows.

## What Was Implemented
- Implemented facade APIs for:
  - `src/lib/data/profile/{server.ts,client.ts,types.ts}`
  - `src/lib/data/households/{server.ts,client.ts,types.ts}`
  - `src/lib/data/invites/{server.ts,client.ts,types.ts}`
- Migrated Slice 2 call-sites from direct helper/action imports to facades:
  - `src/app/onboarding/page.tsx`
  - `src/app/home/layout.tsx`
  - `src/app/home/profile/page.tsx`
  - `src/app/home/page.tsx` (household read path)
  - `src/app/invite/[token]/page.tsx`
  - `src/app/auth/callback/route.ts`
  - `src/lib/proxy/context.ts`
  - `src/components/household-form/household-form.tsx`
- Added focused facade tests:
  - `src/lib/data/profile/server.test.ts`
  - `src/lib/data/households/server.test.ts`
  - `src/lib/data/households/client.test.ts`
  - `src/lib/data/invites/server.test.ts`
  - `src/lib/data/invites/client.test.ts`
- Added Slice 2 migrated UI paths that are now transport-clean:
  - `src/app/home/layout.tsx`
  - `src/app/home/profile/page.tsx`
  - `src/app/invite/[token]/page.tsx`
  - `src/components/household-form/household-form.tsx`

## Key Decisions
- Kept facades as thin delegating wrappers to preserve existing behavior (`payload + optional errorCode`) and avoid transport rewrites.
- Added optional `supabase` injection on households server reads so auth callback/proxy flows can preserve existing authenticated client context without changing semantics.
- Kept `startAcceptFlow` and household create/createInline methods as facade-level server-action wrappers with `'use server'` to preserve formAction behavior.
- Did not mark `src/app/auth/callback/route.ts` or `src/app/home/page.tsx` as migrated UI scopes because they still intentionally import `@lib-supabase/server` for non-Slice-2 logic.

## Touched Files
- `src/lib/data/profile/types.ts`
- `src/lib/data/profile/server.ts`
- `src/lib/data/profile/client.ts`
- `src/lib/data/households/types.ts`
- `src/lib/data/households/server.ts`
- `src/lib/data/households/client.ts`
- `src/lib/data/invites/types.ts`
- `src/lib/data/invites/server.ts`
- `src/lib/data/invites/client.ts`
- `src/app/onboarding/page.tsx`
- `src/app/home/layout.tsx`
- `src/app/home/profile/page.tsx`
- `src/app/home/page.tsx`
- `src/app/invite/[token]/page.tsx`
- `src/app/auth/callback/route.ts`
- `src/lib/proxy/context.ts`
- `src/components/household-form/household-form.tsx`
- `src/lib/data/profile/server.test.ts`
- `src/lib/data/households/server.test.ts`
- `src/lib/data/households/client.test.ts`
- `src/lib/data/invites/server.test.ts`
- `src/lib/data/invites/client.test.ts`
- `implementations/decouple-data-layer/migrated-ui-scopes.json`

## Validations Run + Results
- `pnpm test -- src/lib/data/profile/server.test.ts src/lib/data/households/server.test.ts src/lib/data/households/client.test.ts src/lib/data/invites/server.test.ts src/lib/data/invites/client.test.ts`: pass (5 suites, 15 tests).
- `pnpm lint`: pass (1 pre-existing warning in `src/components/charts/ring-chart.tsx`; data-boundary checks passed).
- `pnpm format:check`: fail due pre-existing unrelated formatting issues in:
  - `.claude/settings.local.json`
  - `skills/momo-ui-builder/agents/openai.yaml`

## Open Risks / Blockers
- `pnpm format:check` remains red because of pre-existing repository files outside Slice 2.
- `src/app/auth/callback/route.ts` and `src/app/home/page.tsx` are migrated for Slice 2 profile/household/invite reads/actions, but cannot be added to migrated-scope enforcement until their direct `@lib-supabase/server` dependencies are addressed by later slices.
