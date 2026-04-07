# Migrated UI Scope Checklist

Use this checklist each time a UI scope is migrated to `src/lib/data/*` facades.

## Scope
- Slice: `<slice-id>`
- Scope label: `<scope-name>`
- Paths added to `implementations/decouple-data-layer/migrated-ui-scopes.json`:
  - `src/...`

## Guardrails
- [ ] No direct imports of `@actions/*` in scope.
- [ ] No direct imports of `@supabase/*` or `@lib-supabase/*` in scope.
- [ ] No raw `fetch('/api/*')` calls in scope.
- [ ] Client files in scope do not import `src/lib/data/*/server`.
- [ ] Server files in scope do not import `src/lib/data/*/client`.

## Behavior parity
- [ ] Existing `payload + optional errorCode` behavior preserved.
- [ ] No redirects/auth-flow changes.
- [ ] No UI/CSS regressions observed.

## Validation
- [ ] Targeted tests for touched scope.
- [ ] `pnpm lint`
- [ ] `pnpm format:check`
