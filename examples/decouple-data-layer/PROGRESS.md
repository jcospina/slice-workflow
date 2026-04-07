# Progress Router - Decouple Data Layer

## Source Plan
- Canonical copy for this work: [decouple-data-layer.md](./decouple-data-layer.md)

## What Is Implemented So Far
- Plan rewritten to "Simple Facade Approach".
- Slice 0 completed:
  - Facade scaffold created at `src/lib/data/<domain>/{server.ts,client.ts,types.ts}`.
  - Boundary checker added (`scripts/check-data-boundaries.mjs`) and wired into `pnpm lint`.
  - Migrated UI scopes config + migration checklist templates added for later slices.
- Slice 1 completed:
  - Implemented `auth` and `prefs` facades (`server.ts`, `client.ts`, `types.ts`) with compatibility-preserving wrappers.
  - Migrated Slice 1 UI call-sites from direct `@actions/login|logout|user-prefs` to data facades.
  - Added Slice 1 migrated UI paths to `migrated-ui-scopes.json`.
  - Added focused facade tests for `auth`/`prefs`.
- Slice 2 completed:
  - Implemented `profile`, `households`, and `invites` facades (`server.ts`, `client.ts`, `types.ts`) as thin wrappers over existing helpers/actions.
  - Migrated Slice 2 profile/household/invite call-sites to facades (onboarding, home layout/profile/home page household read, invite page, auth callback, proxy context, household form client action).
  - Added focused facade tests for `profile`, `households`, and `invites`.
  - Added Slice 2 migrated UI paths to `migrated-ui-scopes.json`.
- Slice 3 completed:
  - Implemented `expenses` and `stats` facades (`server.ts`, `client.ts`, `types.ts`) as thin wrappers over existing actions.
  - Migrated Slice 3 expense/stats call-sites to facades (`src/components/expense-details/expense-details-dialog.tsx`, `src/app/home/stats/page.tsx`).
  - Added focused facade tests for `expenses` and `stats` server/client wrappers.
  - Added Slice 3 migrated UI paths to `migrated-ui-scopes.json`.
- Slice 4 completed:
  - Implemented `messages` facades (`server.ts`, `client.ts`, `types.ts`) for chat reads/writes/realtime sync.
  - Migrated Slice 4 chat call-sites to message facades (`src/app/home/page.tsx`, `src/components/chat/chat.tsx`, and chat realtime/sync hooks).
  - Added focused facade tests for `messages` server/client wrappers and updated chat sync hook tests to use the facade.
  - Added Slice 4 migrated UI paths to `migrated-ui-scopes.json`.
- Slice 5 completed:
  - Consolidated remaining migrated server-page data reads to facades by replacing direct helper imports with `auth`/`prefs` facade imports in migrated scopes.
  - Tightened boundary guardrails so migrated scopes now fail on direct helper/action/supabase transport imports (including relative imports) and raw `/api/*` fetch template literals.
  - Re-validated migrated scopes for facade-only data access and recorded consolidation results in `tracks/05-consolidation.md`.

## Current Focus
- Slice migration complete (`Slice 0`-`Slice 5`).

## Router (Use This To Keep Context Small)
- Foundation/import guardrails: [tracks/00-foundation.md](./tracks/00-foundation.md)
- Auth/onboarding/prefs work: [tracks/01-auth-onboarding-prefs.md](./tracks/01-auth-onboarding-prefs.md)
- Profile/household/invite work: [tracks/02-profile-household-invite.md](./tracks/02-profile-household-invite.md)
- Expenses + stats work: [tracks/03-expenses-stats.md](./tracks/03-expenses-stats.md)
- Chat work: [tracks/04-chat.md](./tracks/04-chat.md)
- Consolidation cleanup: [tracks/05-consolidation.md](./tracks/05-consolidation.md)

## Update Rule
- Keep this file lean.
- Only update: `What Is Implemented So Far`, `Current Focus`, and completion checkboxes.
- Put technical specifics inside the corresponding track file.

## Slice Status
- [x] Slice 0 - Foundation guardrails
- [x] Slice 1 - Auth + Onboarding + Prefs
- [x] Slice 2 - Profile + Household + Invite
- [x] Slice 3 - Expenses + Stats
- [x] Slice 4 - Chat
- [x] Slice 5 - Consolidation
