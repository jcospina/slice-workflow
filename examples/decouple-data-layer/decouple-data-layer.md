# MoMo Data-Layer Decoupling Plan (Simple Facade Approach)

## Goal
Separate UI from Supabase and transport details with a practical, low-risk structure.

Primary outcome:
- UI (components/pages/hooks) must not know about Supabase clients, server actions, or raw `/api/*` fetch calls.
- Data access should be easy to trace and environment-safe.

## Guardrails
- No functionality changes.
- No UI/UX changes.
- Keep existing `payload + optional errorCode` behavior (do not introduce `DataResult` migrations).
- Keep current routes/actions/helpers valid while migrating call-sites.
- Avoid architecture changes that can affect CSS loading order.

## Why This Rewrite
The previous generic adapter/provider approach introduced complexity and regressions:
- server/client import mixups
- hard-to-trace dependency chains
- unintended layout/style breakage risk from broad provider-level wiring

This plan replaces that with explicit domain facades and environment-specific entrypoints.

## Target Architecture (Simple + Explicit)

### Data boundary
Use domain facades under `src/lib/data/`.

```text
src/lib/data/
  auth/
    server.ts
    client.ts
    types.ts
  prefs/
    server.ts
    client.ts
    types.ts
  profile/
    server.ts
    client.ts
    types.ts
  households/
    server.ts
    client.ts
    types.ts
  invites/
    server.ts
    client.ts
    types.ts
  expenses/
    server.ts
    client.ts
    types.ts
  stats/
    server.ts
    client.ts
    types.ts
  messages/
    server.ts
    client.ts
    types.ts
```

### Usage model
- Server components/routes/actions import from `@/lib/data/<domain>/server`.
- Client hooks/components import from `@/lib/data/<domain>/client`.
- No runtime environment detection in shared data modules.
- No generic registry/provider/factory layer.

### Transport rules
- Mutations may continue to use server actions internally.
- Client reads/sync may continue to use existing route handlers internally.
- Supabase usage remains internal to server transport/helpers.

## Public API Shape (Domain Methods)
Keep domain-method style and current error semantics.

Required namespaces and representative methods:
- `auth`: `loginWithProvider`, `logout`, `getCurrentUser`
- `prefs`: `getUserPreferences`, `setOnboardingStatus`, `setCurrency`, `setLanguage`, `setAiEnabled`
- `profile`: `getProfile`
- `households`: `getMembership`, `getHouseholdForUser`, `getMembers`, `create`, `createInline`
- `invites`: `getInviteInfo`, `startAcceptFlow`
- `expenses`: `getByMessageId`, `update`
- `stats`: preserve current exported stats methods
- `messages`: `getList`, `getSince`, `send`, `remove`, `subscribe`

## Import-Safety Rules

### Hard rules
- Client code cannot import `src/lib/data/**/server.ts`.
- Server code cannot import `src/lib/data/**/client.ts`.
- UI layers cannot import:
  - `@supabase/*`
  - `@lib-supabase/*`
  - direct `@actions/*` (after slice migration)
  - direct domain `/api/*` fetches (after slice migration)
- Facades cannot import UI or CSS modules.

### CSS safety rules
- Do not introduce global data providers in app layout as part of this migration.
- Keep CSS imports where they currently live unless a slice explicitly requires a safe move.
- Treat any style/render shift as regression.

## Migration Roadmap (Vertical Slices)

### Slice 0 — Foundation guardrails
Goal:
- Create facade folders and naming conventions.
- Add import-boundary checks and migration checklist templates.

Definition of Done:
- Folder conventions documented and accepted.
- Boundary checks available (even if initially baseline-driven).
- No call-site behavior changes.

### Slice 1 — Auth + Onboarding + Prefs (first priority)
Goal:
- Move auth/onboarding/prefs call-sites to `src/lib/data/*` facades.

Definition of Done:
- Migrated scope has no direct `@actions/login`, `@actions/logout`, `@actions/user-prefs` imports.
- Redirects/error behavior unchanged.
- No style regressions in login/onboarding/profile settings paths.

### Slice 2 — Profile + Household + Invite
Goal:
- Move profile, household, and invite call-sites to facades.

Definition of Done:
- Migrated scope no longer calls helpers/actions directly.
- Invite flow and onboarding continuation behavior unchanged.

### Slice 3 — Expenses + Stats
Goal:
- Move expense detail/mutation and stats reads to facades.

Definition of Done:
- Currency and parsing invariants preserved.
- Stats payload shapes remain unchanged for chart components.

### Slice 4 — Chat (last, highest risk)
Goal:
- Move chat reads/writes/realtime sync to `messages` facades.

Definition of Done:
- Optimistic/reconcile/dedupe behavior unchanged.
- Realtime + sync fallback behavior unchanged.
- No direct `@actions/chat-messages` or raw chat route fetches in migrated chat scope.

### Slice 5 — Consolidation
Goal:
- Final cleanup and strict boundary enforcement across migrated scopes.

Definition of Done:
- Migrated UI layers use facades only.
- Remaining direct transport imports are intentionally scoped and documented.

## Verification Strategy

### Import-boundary checks
- Detect client imports of `server.ts` and server imports of `client.ts`.
- Detect forbidden direct imports/fetches in migrated scopes.

### Behavioral parity checks
- Auth/onboarding redirects and error handling
- Expense amount parsing and currency units
- Stats month-window and aggregation parity
- Chat optimistic/reconcile/dedupe + sync recovery

### UI regression smoke checks
After each slice verify:
- login
- onboarding
- home/chat
- profile
- stats

### Standard validation flow
Per slice:
1. targeted tests for touched area
2. `pnpm lint`
3. `pnpm format:check`
4. `pnpm test`

## Assumptions
- This is a maintainability-focused decoupling, not a backend-swap architecture exercise.
- Supabase remains current backend.
- Existing routes/actions/helpers remain internal building blocks during migration.
- Plan rewrite is immediate deliverable; code migration follows this plan.
