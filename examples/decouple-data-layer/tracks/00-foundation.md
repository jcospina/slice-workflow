# Slice 0 - Foundation Guardrails

## Scope
- Establish `src/lib/data/<domain>/{server.ts,client.ts,types.ts}` convention.
- Add import-boundary checks for server/client entrypoint misuse.
- Add forbidden-import checks for migrated UI scopes.

## DoD
- Guardrails and checks exist.
- No call-site behavior changes.

## Notes
- Keep CSS imports untouched while setting up guardrails.

## What Was Implemented
- Added `src/lib/data/README.md` documenting facade conventions and guardrails.
- Added facade scaffold directories and files for:
  - `auth`, `prefs`, `profile`, `households`, `invites`, `expenses`, `stats`, `messages`
  - each with `server.ts`, `client.ts`, `types.ts` placeholder modules.
- Added `scripts/check-data-boundaries.mjs` to enforce:
  - client modules cannot import `src/lib/data/*/server`
  - server modules cannot import `src/lib/data/*/client`
  - data facades cannot import UI layers or CSS
  - migrated UI scopes cannot import `@actions/*`, `@supabase/*`, `@lib-supabase/*`, or call raw `fetch('/api/*')`
- Added `implementations/decouple-data-layer/migrated-ui-scopes.json` (baseline empty in Slice 0).
- Added checklist templates:
  - `implementations/decouple-data-layer/templates/migrated-ui-scope-checklist.md`
  - `implementations/decouple-data-layer/templates/slice-execution-checklist.md`
- Wired boundary checks into lint pipeline via `package.json`:
  - `lint` now runs `lint:eslint` + `lint:data-boundaries`.

## Key Decisions
- Keep migrated-scope enforcement baseline-driven with an empty `scopes` list in Slice 0 to avoid false-positive blocking before any slice migration.
- Enforce guardrails through a dedicated script rather than broad ESLint overrides so checks can use `'use client'` detection and migrated-scope config.
- Preserve behavior by avoiding any call-site rewiring in this slice.

## Touched Files
- `src/lib/data/README.md`
- `src/lib/data/auth/{server.ts,client.ts,types.ts}`
- `src/lib/data/prefs/{server.ts,client.ts,types.ts}`
- `src/lib/data/profile/{server.ts,client.ts,types.ts}`
- `src/lib/data/households/{server.ts,client.ts,types.ts}`
- `src/lib/data/invites/{server.ts,client.ts,types.ts}`
- `src/lib/data/expenses/{server.ts,client.ts,types.ts}`
- `src/lib/data/stats/{server.ts,client.ts,types.ts}`
- `src/lib/data/messages/{server.ts,client.ts,types.ts}`
- `scripts/check-data-boundaries.mjs`
- `implementations/decouple-data-layer/migrated-ui-scopes.json`
- `implementations/decouple-data-layer/templates/migrated-ui-scope-checklist.md`
- `implementations/decouple-data-layer/templates/slice-execution-checklist.md`
- `package.json`

## Validations Run + Results
- `pnpm lint`: pass (1 pre-existing warning in `src/components/charts/ring-chart.tsx` about `react-hooks/exhaustive-deps`; no errors).
- `pnpm format:check`: fail due pre-existing unrelated formatting issues in:
  - `.claude/settings.local.json`
  - `skills/momo-ui-builder/agents/openai.yaml`

## Open Risks / Blockers
- Boundary checks currently treat server/client context via folder conventions + `'use client'` directive detection; if future file-placement patterns diverge, script rules may need tuning.
- Repository-wide formatting check is currently red because of pre-existing files outside Slice 0 scope.
