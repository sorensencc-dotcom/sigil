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
