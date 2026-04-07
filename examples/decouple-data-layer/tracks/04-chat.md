# Slice 4 - Chat

## Scope
- Migrate chat reads/writes/sync/realtime through `messages` facades.

## DoD
- Optimistic/reconcile/dedupe behavior unchanged.
- Realtime + sync fallback unchanged.
- No direct `@actions/chat-messages` imports or raw chat route fetches in migrated chat scope.

## Validation
- Run chat hook/component tests and realtime/sync recovery scenarios.

## What Was Implemented
- Implemented facade APIs for:
  - `src/lib/data/messages/{server.ts,client.ts,types.ts}`
- Added chat facade coverage:
  - `src/lib/data/messages/server.test.ts`
  - `src/lib/data/messages/client.test.ts`
- Migrated Slice 4 chat call-sites to facades:
  - `src/app/home/page.tsx` -> `@/lib/data/messages/server`
  - `src/components/chat/chat.tsx` -> `@/lib/data/messages/client`
  - `src/features/chat/hooks/use-household-sync.ts` -> `@/lib/data/messages/client`
  - `src/features/chat/hooks/use-personal-sync.ts` -> `@/lib/data/messages/client`
  - `src/features/chat/hooks/use-household-realtime.ts` -> `@/lib/data/messages/client`
  - `src/features/chat/hooks/use-personal-realtime.ts` -> `@/lib/data/messages/client`
- Updated `src/app/api/chat-history/route.ts` to read through `@/lib/data/messages/server`.
- Added a shared sync helper used by the server facade:
  - `src/lib/helpers/chat/chat-messages.ts` (`fetchChatMessagesSince`)
- Updated migrated chat UI scope paths in:
  - `implementations/decouple-data-layer/migrated-ui-scopes.json`

## Key Decisions
- Kept facades as thin wrappers over existing actions/helpers/routes to preserve `payload + optional errorCode` compatibility.
- Preserved optimistic/reconcile/dedupe behavior by changing only transport import points in chat panel/hooks.
- Preserved realtime + sync fallback behavior by reusing existing callback flow and resubscribe logic; only subscription/sync access moved behind `messages` client facade.
- Kept `/api/chat-sync` error semantics unchanged (still returns `500` on sync query failure).

## Touched Files
- `src/lib/data/messages/types.ts`
- `src/lib/data/messages/server.ts`
- `src/lib/data/messages/client.ts`
- `src/lib/data/messages/server.test.ts`
- `src/lib/data/messages/client.test.ts`
- `src/lib/helpers/chat/chat-messages.ts`
- `src/app/home/page.tsx`
- `src/components/chat/chat.tsx`
- `src/features/chat/hooks/use-household-sync.ts`
- `src/features/chat/hooks/use-personal-sync.ts`
- `src/features/chat/hooks/use-household-realtime.ts`
- `src/features/chat/hooks/use-personal-realtime.ts`
- `src/features/chat/hooks/use-household-sync.test.tsx`
- `src/app/api/chat-history/route.ts`
- `implementations/decouple-data-layer/migrated-ui-scopes.json`
- `implementations/decouple-data-layer/PROGRESS.md`
- `implementations/decouple-data-layer/tracks/04-chat.md`

## Validations Run + Results
- `pnpm test -- src/lib/data/messages/server.test.ts src/lib/data/messages/client.test.ts src/features/chat/hooks/use-household-sync.test.tsx src/features/chat/hooks/use-household-realtime.test.tsx src/features/chat/hooks/use-chat-state.test.tsx`: pass (5 suites, 19 tests).
- `pnpm lint`: pass (data-boundary checks passed; 1 pre-existing warning in `src/components/charts/ring-chart.tsx`).
- `pnpm format:check`: fail due pre-existing unrelated formatting issues in:
  - `.claude/settings.local.json`
  - `skills/momo-ui-builder/agents/openai.yaml`

## Open Risks / Blockers
- `pnpm format:check` remains red because of pre-existing repository files outside Slice 4.
