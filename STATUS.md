# Status

## Current goal
Patch the relay recipient-not-found gate for domain-qualified envelope recipients.

## Completed work
- Added a transaction-scoped durable recipient lookup before envelope persistence.
- Added `RECIPIENT_NOT_FOUND` as a 400 response.
- Added regression coverage proving unregistered local-parts fail closed.

## Tests
- `node --test sigil/relay/v1/http-server.test.mjs sigil/relay/v1/accept-envelope.test.mjs sigil/relay/v1/postgres-repository.test.mjs` — 94 passed.
- `git diff --check` — passed.

## Decisions
- The active relay repository is PostgreSQL-backed; the lookup uses the repository transaction client and checks active `endpoints` plus an active `endpoint_keys` row.

## Blockers
- None.

## Next action
- Review and merge the patch.

## Production packaging and host adapters (2026-08-27)

### Completed work
- Added `sigil/cli/package.json` with the global `sigil` binary mapping to `./sigil.mjs`.
- Added Windows PowerShell, macOS/Linux shell, and callback guidance for one-shot inbox waits and safe re-arm behavior.

### Tests
- Package metadata validation passed.
- Focused daemon test requires child-process execution; the restricted sandbox returned `spawn EPERM`.

### Next action
- Re-run the focused test outside the restricted sandbox or in CI.
