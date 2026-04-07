# Slice Execution Checklist

## Before implementation
- [ ] Confirm the target slice track file scope/DoD.
- [ ] Confirm no cross-slice changes unless strictly required.
- [ ] Confirm migrated UI scopes list update plan.

## During implementation
- [ ] Introduce/adjust facades in `src/lib/data/<domain>/{server.ts,client.ts,types.ts}`.
- [ ] Keep server/client entrypoint boundaries intact.
- [ ] Keep UI behavior and CSS imports unchanged.
- [ ] Preserve `payload + optional errorCode` compatibility.

## Before handoff
- [ ] Update `implementations/decouple-data-layer/PROGRESS.md`.
- [ ] Update the active track file with decisions, touched files, and validation results.
- [ ] Run required validations for the slice.
- [ ] Prepare ready-to-copy prompt for next slice.
