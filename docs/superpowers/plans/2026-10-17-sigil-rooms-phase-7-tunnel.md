# Sigil rooms phase 7 (reply ingress tunnel) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person @mention Chief or Helix CI Triage in a room and see the bot's answer in the thread, even though the bot runs in Grok's cloud. Give Grok's cloud one narrow, authenticated way to reach the reply route. To do that, add a dedicated loopback reply ingress listener, per-bot reply tokens, layered fail-closed limits and a tightened https rule for the bridge reply URL. Add the operator commands and the runbook to run the ingress behind a provider tunnel.

**Architecture:** Task 1 settles the facts the design marks as unverified. Tasks 2-5 add the data, the repository methods, the reply token module and the `sigil bot token` commands. Task 6 moves the reply gate out of `http-server.mjs` into a shared module. Tasks 7-9 add the ingress listener, its limits and metrics, and the `relay up` flags with startup validation. Task 10 tightens the bridge reply URL rule. Task 11 adds `sigil ingress status` and `sigil ingress doctor`. Tasks 12-13 prove the whole path with Postgres tests over real HTTP and an end-to-end run through the loopback TLS proxy. Tasks 14-15 add the provider runbook and the gated live transport smoke procedure. Task 16 closes docs and full verification.

**Tech Stack:** Node `.mjs` with `node:test`, `pg`, Postgres 15, `ws`. No TypeScript and no web client change in this phase. The provider tools (`cloudflared`, `tailscale`) appear only in Tasks 14 and 15 as documented steps.

**Spec:** `docs/superpowers/specs/2026-10-17-sigil-rooms-phase-7-tunnel-design.md` (read it first; this plan cites it as "spec"). Parent: `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md`.

## Global constraints

- Branch off `origin/main` in a worktree. Never switch branches in `C:\dev\sigil-repo` and never stash, reset or check out over its uncommitted work. No push, no PR and no merge unless Chris asks.
- Paths below are relative to `sigil/` unless they start with `packages/` or `docs/`. Relay code is `relay/v1/`, bridges are `bridges/v1/`.
- Unit tests run with `timeout 60 node --test <file>`. Postgres tests read `SIGIL_TEST_DATABASE_URL`, skip without it, call `assertDisposableTestDatabase`, and run `applyMigrations(url, { reset: true })`. **Run one `node --test` process at a time.** Overlapping runs deadlock the shared database.
- Postgres evidence rule. A pg test file counts as evidence only when it runs with `SIGIL_TEST_DATABASE_URL` set to a database whose name ends in `_test`. Paste the pass count and the skip count of each named pg file into the PR. A skipped pg test is not evidence.
- Never read, print, copy or commit anything in `.sigil/*.json`. Tests build identities and registries in a temp directory.
- Never create `ep_chief` or `ep_helix_ci`, never run `sigil bot add` against a real database, and never call the real Grok routine. Chris declined endpoint setup. Tests use fixture ids such as `ep_test_bot` and `bot_test`.
- Never start a tunnel, never touch a Cloudflare or Tailscale account, and never change DNS from a test or from any task except Task 15. Task 15 runs only after Chris approves provider setup in writing. Tests use loopback listeners and the loopback TLS proxy fixture (`integration/fixtures/loopback-tls-proxy.mjs`).
- This plan changes the repo only. Never edit `C:\dev\scripts\run-sigil-daemon.ps1`, never read its contents, and never print any database setting. The plan flags the 8792 versus 8793 stream port drift and does not resolve it.
- Secrets arrive through environment variable names (`--...-env`), never argv. No test, log line, error message or audit row may contain a reply token, a key, a webhook URL or an Access service-token value. `sigil bot token create` prints the plaintext once to stdout and takes no token as input.
- Migration number is 039 on this checkout (highest is `035_floor_warden_bridge.sql`; 036 to 038 are reserved and unbuilt). Re-check with `ls sigil/migrations | tail -3` at execution. Renumber only upward. Never go below 039 while 036 to 038 are unmerged, and never reuse 035 to 038.
- Every `INSERT INTO endpoints` sets `kind` explicitly (the column has no default).
- Relay error bodies are `{request_id, code, message, details?}`. Use the same error helper pattern the existing room and reply routes use.
- Both repositories (`relay/v1/postgres-repository.mjs`, `cli/memory-repository.mjs`) get every new method.
- Every commit message ends with the `Co-Authored-By` trailer the repo uses for the agent that wrote the commit. Use `test(sigil):` for commits that mainly add tests and `docs(sigil):` for docs.
- Files are LF. Before using an edit tool on a file, run `file <path>`. If it reports CRLF, edit with a script that preserves line endings.
- Docs follow the repo's technical-writing rules. Use sentence case headings, no first-person plural, and active voice.

---

## File structure

Relay (`sigil/`):

- Create (new) `migrations/039_reply_ingress.sql` and `migrations/039_reply_ingress.test.mjs`.
- Create (new) `relay/v1/reply-token.mjs` (+ test), `relay/v1/floor-warden-gate.mjs` (+ test), `relay/v1/reply-ingress.mjs` (+ test), `relay/v1/reply-ingress-limits.test.mjs`, `relay/v1/oauth/public-listener.reply-route.test.mjs`.
- Create (new) `relay/v1/floor-warden-reply-tokens.pg.test.mjs`, `relay/v1/reply-ingress.pg.test.mjs`, `relay/v1/floor-warden-ingress-e2e.pg.test.mjs`.
- Modify `relay/v1/http-server.mjs` (main route calls the gate), `relay/v1/postgres-repository.mjs`, `cli/memory-repository.mjs`, `relay/v1/relay-config.mjs` (limit defaults).
- Modify `relay/v1/floor-warden-replies.test.mjs` only if an import path changes.

CLI (`sigil/`):

- Create (new) `cli/ingress-commands.mjs` (+ `cli/ingress-commands.test.mjs`, `cli/ingress-commands.pg.test.mjs`).
- Create (new) `cli/memory-repository.reply-tokens.test.mjs`, `cli/bot-token-commands.pg.test.mjs`, `cli/relay-up-ingress.test.mjs`.
- Modify `cli/bot-commands.mjs`, `cli/sigil.mjs` (usage, dispatch, relay flags, startup validation, bridge reply URL rule), `cli/agent-run-floor-warden.test.mjs`.

Docs:

- Create (new) `docs/superpowers/plans/2026-10-17-reply-ingress-verification-notes.md` (Task 1), `docs/reply-ingress-runbook.md` (Task 14), `docs/superpowers/plans/2026-10-17-reply-ingress-smoke-notes.md` (Task 15).
- Modify `README.md`, `STATUS.md`, `CHANGELOG.md`, `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md` (Task 16). `docs/superpowers/specs/2026-10-16-sigil-hybrid-dm-decisions.md` is not modified.

## Interfaces fixed up front

```js
// relay/v1/reply-token.mjs (new)
generateReplyToken()                       // -> { token: 'fwr_' + base64url(32 random bytes), tokenId: 'frt_' + 16 random bytes hex, sha256: Buffer }
hashReplyToken(token)                      // -> Buffer, SHA-256 of the UTF-8 token
isReplyTokenShape(value)                   // -> boolean, /^fwr_[A-Za-z0-9_-]{43}$/ ; cheap pre-check before any database call
evaluateReplyToken(row, now)               // -> { ok: true } | { ok: false, reason: 'unknown'|'revoked'|'expired' } ; active ok; retired ok only while expires_at > now; revoked never
createReplyTokenMatcher({ repository, now, globalTokens, allowGlobal, touchIntervalMs = 60_000 })
                                           // -> async match(bearer) -> { kind: 'bot', botId, tokenId } | { kind: 'global' } | null
// relay/v1/floor-warden-gate.mjs (new)
createFloorWardenGate({ match, handler, authenticateRequest, distinguishEndpointPrincipal, logger })
                                           // -> async gate({ request, response, requestId, roomId, now, readBody }) ; same answers as today's inline route
// relay/v1/reply-ingress.mjs (new)
createReplyIngress({ gate, limiter, perBotLimiter, metrics, logger, bodyMaxBytes = 96 * 1024, requestTimeoutMs = 10_000, ratePerMinute = 120, now })
                                           // -> { server: http.Server, listen(port) } ; one route, fixed 404 otherwise
// repository methods (both postgres-repository.mjs and cli/memory-repository.mjs)
insertReplyToken({ tokenId, botId, tokenSha256, status, createdAt, expiresAt }, client)
lookupReplyTokenByHash(tokenSha256, client)           // -> row | null
retireActiveReplyTokens(botId, expiresAt, client)     // -> number of rows retired
revokeReplyToken(tokenId, now, client)                // -> boolean
listReplyTokens(botId, client)                        // -> rows without the hash
touchReplyTokenLastUsed(tokenId, now, minIntervalMs, client) // -> boolean (true when it wrote)
countAcceptedReplies({ botId, since }, client)        // -> number, from audit rows room.floor_warden_reply with outcome accepted
// reserveRateLimit(scopeKind, scopeId, windowStart, limit, client) already exists; new scope kind: 'floor_warden_reply'
// cli
sigil bot token create|rotate|revoke|list ; sigil ingress status ; sigil ingress doctor --origin <url> [--access-client-id-env N --access-client-secret-env N] [--relay-port N --stream-port N --public-port N --ingress-port N]
// relay up flags: --ingress-origin, --ingress-port, --ingress-rate-per-minute, --ingress-allow-global-token
// gate option: distinguishEndpointPrincipal (true on the main relay route, false on the ingress)
```

---

### Task 1: Settle the unverified facts

**Files:**
- Create: `docs/superpowers/plans/2026-10-17-reply-ingress-verification-notes.md`
- Create: `relay/v1/oauth/public-listener.reply-route.test.mjs`

**Interfaces:** Produces the answers to spec assumptions A8, A10 and A12 and the facts Tasks 2, 6, 7, 8, 9 and 11 depend on. Consumes `createPublicListener` and `matchPublicRoute` from `relay/v1/oauth/public-listener.mjs`.

- [ ] **Step 1: Write the characterization test**

Read `relay/v1/oauth/public-listener.mjs` first and record how `createPublicListener` takes its dependencies. Build the listener with stub dependencies. Cases:

- A `POST /v1/rooms/room_x/replies` with `Authorization: Bearer fwr_stub` and no cookie answers `401` with code `UNAUTHENTICATED`.
- `matchPublicRoute('POST', '/v1/rooms/room_x/replies')` returns `'rooms'`.
- The stub `authenticateCookie` is called, and the stub reply handler is never called.

- [ ] **Step 2: Run the test**

Run: `timeout 60 node --test sigil/relay/v1/oauth/public-listener.reply-route.test.mjs`
Expected: PASS. This test characterizes existing behavior, so it cannot fail first. A failure means assumption A8 is wrong. Stop and report the finding in the notes file before any other task.

- [ ] **Step 3: Read the live quota constraint**

On a disposable Postgres (name ends in `_test`), run `applyMigrations(url, { reset: true })`, then run:

```bash
psql "$SIGIL_TEST_DATABASE_URL" -Atc "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'quota_usage_scope_kind_check'"
```

Record the full kind list. Compare it with the 034 list in the spec's Data section (assumption A12).

- [ ] **Step 4: Check the migration folder**

```bash
ls sigil/migrations | tail -3
```

Record whether 036, 037 or 038 have landed and whether any of them touches `quota_usage`. Record the number Task 2 must use (039 or higher).

- [ ] **Step 5: Read the current reply route and handler**

Read `relay/v1/http-server.mjs` lines 253 to 296, `relay/v1/floor-warden-replies.mjs` and `relay/v1/accept-envelope.mjs`. Record these facts.

- How the route answers a body over the cap today (the handler answers `400 INVALID_REQUEST`).
- The `RATE_LIMITED` code and status the accept path uses, and the body shape of that `429`.
- Which gate answers are inline in `http-server.mjs` and which come from the handler.

- [ ] **Step 6: Check for a `Retry-After` convention**

```bash
grep -rn "Retry-After\|retry-after" sigil --include=*.mjs | grep -v test
```

Record whether the repo already sets `Retry-After` on a `429`, and in what unit. Task 8 follows it.

- [ ] **Step 7: Record ports and the bridge set**

Record the default ports for relay 8791 (stream port plus 1 is 8792, public port plus 2 is 8793, ingress port plus 3 is 8794). Flag the 8793 overlap with the mesh skill's stream port as a flag only. Read `relay/v1/transport-tincan/wake-dispatcher.mjs` and record that `BRIDGES` has no `floor-warden` entry and that this plan adds none. Do not read or open `run-sigil-daemon.ps1`.

- [ ] **Step 8: Write the notes file**

Write one short section for each of steps 3 to 7, with file and line references. Include the list of quota kinds exactly as found, because Task 2 repeats it.

- [ ] **Step 9: Commit**

```bash
git add docs/superpowers/plans/2026-10-17-reply-ingress-verification-notes.md sigil/relay/v1/oauth/public-listener.reply-route.test.mjs
git commit -m "test(sigil): characterize the cookie listener reply route and record ingress facts"
```

---

### Task 2: Migration 039

**Files:**
- Create: `migrations/039_reply_ingress.sql`, `migrations/039_reply_ingress.test.mjs`

**Interfaces:** Produces table `floor_warden_reply_tokens` and the extended `quota_usage_scope_kind_check`. Consumes the kind list recorded in Task 1.

- [ ] **Step 1: Write failing tests**

Model the test on `migrations/035_floor_warden_bridge.test.mjs` (read it first). Cases:

- `floor_warden_reply_tokens` exists with the columns from the spec's Data section, and an index on `(bot_id, status)` exists.
- Every earlier kind from the Task 1 list is still accepted by `quota_usage`.
- `floor_warden_reply` is accepted, and an unknown kind is refused.
- `bot_id` must reference `floor_warden_bots`.
- `token_sha256` is unique, and `status` rejects a value outside `active`, `retired` and `revoked`.
- Out-of-order apply with stub 036, 037 and 038 files placed after the real 035 and before 039. Each stub drops and re-adds the check with the full list, and the final check still holds every kind.
- A second case with 039 applied first and the stubs after it. Each stub re-adds the list including `floor_warden_reply`, and the test asserts the final check keeps every kind.
- Re-applying the migration is a no-op.

- [ ] **Step 2: Run to confirm failure**

Run: `timeout 60 node --test sigil/migrations/039_reply_ingress.test.mjs`
Expected: FAIL (table missing).

- [ ] **Step 3: Write the migration**

Use `CREATE TABLE IF NOT EXISTS` for the table and `CREATE INDEX IF NOT EXISTS` for the index. Drop and re-add `quota_usage_scope_kind_check`, repeating the full list from Task 1 plus `floor_warden_reply`. Use the number Task 1 recorded.

- [ ] **Step 4: Run to confirm pass**

Run: `timeout 60 node --test sigil/migrations/039_reply_ingress.test.mjs`
Expected: PASS. Run this with `SIGIL_TEST_DATABASE_URL` set so no case skips.

- [ ] **Step 5: Commit**

```bash
git add sigil/migrations/039_reply_ingress.sql sigil/migrations/039_reply_ingress.test.mjs
git commit -m "feat(sigil): add reply ingress token table and the floor_warden_reply quota kind"
```

---

### Task 3: Repository token methods and parity

**Files:**
- Modify: `relay/v1/postgres-repository.mjs`, `cli/memory-repository.mjs`
- Create: `relay/v1/floor-warden-reply-tokens.pg.test.mjs`, `cli/memory-repository.reply-tokens.test.mjs`

**Interfaces:** Produces `insertReplyToken`, `lookupReplyTokenByHash`, `retireActiveReplyTokens`, `revokeReplyToken`, `listReplyTokens`, `touchReplyTokenLastUsed` and `countAcceptedReplies`, as listed under "Interfaces fixed up front". Consumes migration 039.

- [ ] **Step 1: Write failing tests (memory)**

Write one table of cases in `cli/memory-repository.reply-tokens.test.mjs`. Read how `reserveRateLimit` and the audit method are implemented in `cli/memory-repository.mjs` first, and record where the new methods fit. Cases:

- Insert then lookup by hash returns the row.
- An unknown hash returns `null`.
- `retireActiveReplyTokens` sets `status: 'retired'` and `expires_at` on every active token for the bot, returns the count, and leaves other bots alone. A lookup afterward shows the retired row.
- `revokeReplyToken` returns `true` the first time and `false` the second time, and sets `revoked_at`.
- `listReplyTokens` returns ids, status and timestamps and never returns `token_sha256`.
- `touchReplyTokenLastUsed` writes only when `last_used_at` is null or older than `minIntervalMs`, and returns `true` only when it wrote.
- `countAcceptedReplies` counts only `room.floor_warden_reply` audit rows with outcome accepted for the bot at or after `since`. It ignores refused rows, other bots and older rows.
- `reserveRateLimit` accepts the scope kind `floor_warden_reply`.

- [ ] **Step 2: Write the same cases as a Postgres test**

Use the same case names in `relay/v1/floor-warden-reply-tokens.pg.test.mjs`, behind `assertDisposableTestDatabase`. Add a case that inserts a token for a bot id missing from `floor_warden_bots` and expects the foreign key to refuse it.

- [ ] **Step 3: Run to confirm failure**

Run: `timeout 60 node --test sigil/cli/memory-repository.reply-tokens.test.mjs`
Expected: FAIL (methods missing).

- [ ] **Step 4: Implement in both repositories**

Add the seven methods to `relay/v1/postgres-repository.mjs` and `cli/memory-repository.mjs` with the same signatures. The Postgres throttle is one `UPDATE ... WHERE token_id = $1 AND (last_used_at IS NULL OR last_used_at < $2)` that reports whether a row changed. Do not change the `reserveRateLimit` signature.

- [ ] **Step 5: Run to confirm pass**

Run: `timeout 60 node --test sigil/cli/memory-repository.reply-tokens.test.mjs`
Then, with `SIGIL_TEST_DATABASE_URL` set, run `timeout 60 node --test sigil/relay/v1/floor-warden-reply-tokens.pg.test.mjs`.
Expected: PASS for both. Record the pass and skip counts of the pg file.

- [ ] **Step 6: Commit**

```bash
git add sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.mjs sigil/cli/memory-repository.reply-tokens.test.mjs sigil/relay/v1/floor-warden-reply-tokens.pg.test.mjs
git commit -m "feat(sigil): add reply token repository methods to both repositories"
```

---

### Task 4: Reply token module

**Files:**
- Create: `relay/v1/reply-token.mjs`, `relay/v1/reply-token.test.mjs`

**Interfaces:** Produces `generateReplyToken`, `hashReplyToken`, `isReplyTokenShape`, `evaluateReplyToken` and `createReplyTokenMatcher`. Consumes Task 3 methods and the `loadReplyTokens` result from `relay/v1/floor-warden-token.mjs` (read it first and record the shape of its `matches(bearer)` method).

- [ ] **Step 1: Write failing tests**

Use a fake repository that counts calls. Cases:

- Shape table. A token from `generateReplyToken` passes. Wrong prefix, 42 characters, 44 characters, a character outside base64url, an empty string and `undefined` fail.
- `generateReplyToken` returns `tokenId` with prefix `frt_` plus 32 hex characters, and a `sha256` equal to `hashReplyToken(token)`.
- Status table for `evaluateReplyToken`. Active is ok. Retired with `expires_at` in the future is ok. Retired with `expires_at` in the past is `expired`. Revoked is `revoked`. A `null` row is `unknown`.
- `createReplyTokenMatcher` with a malformed bearer returns `null` and makes zero repository calls.
- A valid active token returns `{ kind: 'bot', botId, tokenId }`. Unknown, revoked and expired tokens return `null`.
- Global matcher off. A bearer equal to the global token returns `null`. Global matcher on. The same bearer returns `{ kind: 'global' }`.
- A bot token still wins when `allowGlobal` is true.
- The touch calls `touchReplyTokenLastUsed` with `touchIntervalMs`. A rejected touch is logged and never changes the answer or delays it.
- No token text appears in any logged line or thrown error.

- [ ] **Step 2: Run to confirm failure**

Run: `timeout 60 node --test sigil/relay/v1/reply-token.test.mjs`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Use `node:crypto` for random bytes and SHA-256. Check shape first, then hash, then look up by hash, then call `evaluateReplyToken`. Fire the touch without waiting on it, so a touch failure never reaches the response path. Consult `globalTokens` only when `allowGlobal` is true.

- [ ] **Step 4: Run to confirm pass**

Run: `timeout 60 node --test sigil/relay/v1/reply-token.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/reply-token.mjs sigil/relay/v1/reply-token.test.mjs
git commit -m "feat(sigil): add the per-bot reply token format, matcher, and status rules"
```

---

### Task 5: `sigil bot token` commands and audit events

**Files:**
- Modify: `cli/bot-commands.mjs`, `cli/sigil.mjs` (usage text and dispatch next to `bot add` and `bot disable`)
- Create: `cli/bot-token-commands.pg.test.mjs`

**Interfaces:** Produces `sigil bot token create|rotate|revoke|list` and the audit event types `ingress.token_created`, `ingress.token_rotated` and `ingress.token_revoked`. Consumes Tasks 3 and 4 and `lookupFloorWardenBot`.

- [ ] **Step 1: Write failing Postgres tests**

Run on a disposable database. Provision a fixture bot (`ep_test_bot`, `bot_test`) in the test setup with the same functions the phase 6 `bot add` tests use (read `cli/bot-commands.mjs` and `cli/bot-commands.pg.test.mjs` first). Capture stdout and stderr of each command. Cases:

- `create` prints the plaintext token once on stdout, stores only the hash, and writes an `ingress.token_created` audit row with `bot_id` and `token_id` only.
- `create` for an unknown bot and for a disabled bot is refused with a clear message and writes nothing.
- `create --expires-in-days 3` sets `expires_at` about three days out. A non-positive value is refused.
- `rotate` creates a new active token, retires every other active token for the bot with `expires_at` equal to now plus `--grace-minutes` (default 1440), prints the new plaintext once, and writes `ingress.token_rotated`. Rotating twice leaves one active token.
- `revoke --token-id` sets the token revoked, is idempotent on a second call, and writes `ingress.token_revoked`. An unknown id is refused.
- `list` prints ids, statuses and ages for the bot and prints no plaintext and no hash.
- Secret scan. The plaintext appears exactly once in all captured output and never in audit rows or log lines.
- No command takes a token on argv. The token is output only.

- [ ] **Step 2: Run to confirm failure**

Run: `timeout 60 node --test sigil/cli/bot-token-commands.pg.test.mjs`
Expected: FAIL (commands missing). Run it with `SIGIL_TEST_DATABASE_URL` set.

- [ ] **Step 3: Implement**

Add the four handlers to `cli/bot-commands.mjs`. Use `generateReplyToken` and one repository transaction per command so the token row and the audit row commit together. Read how `room.floor_warden_reply` audit rows are written in `relay/v1/floor-warden-replies.mjs` and use the same repository audit method. Wire `bot token ...` into the dispatcher and usage text in `cli/sigil.mjs` next to `bot add` and `bot disable`.

- [ ] **Step 4: Run to confirm pass**

Run: `timeout 60 node --test sigil/cli/bot-token-commands.pg.test.mjs`
Then run the existing `timeout 60 node --test sigil/cli/bot-commands.pg.test.mjs` to confirm no regression.
Expected: PASS. Record the pass and skip counts.

- [ ] **Step 5: Commit**

```bash
git add sigil/cli/bot-commands.mjs sigil/cli/sigil.mjs sigil/cli/bot-token-commands.pg.test.mjs
git commit -m "feat(sigil): add sigil bot token create, rotate, revoke, and list"
```

---

### Task 6: Shared gate refactor

**Files:**
- Create: `relay/v1/floor-warden-gate.mjs`, `relay/v1/floor-warden-gate.test.mjs`
- Modify: `relay/v1/http-server.mjs` (lines 253 to 296 call the gate), `relay/v1/floor-warden-replies.test.mjs` only if an import path changes

**Interfaces:** Produces `createFloorWardenGate`. Consumes the Task 1 notes on the current inline route.

- [ ] **Step 1: Write the request table against current behavior**

Read the inline route in `relay/v1/http-server.mjs` lines 253 to 296 first. In `relay/v1/floor-warden-gate.test.mjs`, write one request table that drives the main relay route as it exists today. Rows:

- Route unconfigured (`floorWardenReplies?.tokens` absent) answers `404 NOT_FOUND` for any bearer.
- No bearer and a wrong bearer answer `401 UNAUTHENTICATED`.
- A valid endpoint bearer (human and agent) answers `403 ROUTE_NOT_AUTHORIZED`.
- A matching reply token with no handler answers `503 FLOOR_WARDEN_UNAVAILABLE`.
- A bad room id encoding answers `400 INVALID_REQUEST`.
- A handler that throws answers `503 DATABASE_UNAVAILABLE`, and the `floor_warden_reply_failed` log line carries only the request id and code.
- A matching token reaches the stub handler and the handler's answer passes through.

- [ ] **Step 2: Run to confirm the table passes before any move**

Run: `timeout 60 node --test sigil/relay/v1/floor-warden-gate.test.mjs`
Expected: PASS. The table characterizes current behavior. If a row fails, fix the row to match the current code and record the difference in a comment.

- [ ] **Step 3: Write failing gate tests**

Add a second block that calls `createFloorWardenGate` directly. Cases:

- The same table through a gate built with `distinguishEndpointPrincipal: true` matches the first block row for row.
- With `distinguishEndpointPrincipal: false`, the endpoint-bearer row becomes `401 UNAUTHENTICATED`, and a spy on `authenticateRequest` shows zero calls.
- All other rows are equal in both modes.
- A matcher result of `{ kind: 'bot', botId, tokenId }` reaches the handler with the bot id available to it (record in the test what the handler receives).

- [ ] **Step 4: Run to confirm failure**

Run: `timeout 60 node --test sigil/relay/v1/floor-warden-gate.test.mjs`
Expected: FAIL (module missing).

- [ ] **Step 5: Move the code**

Create `relay/v1/floor-warden-gate.mjs` holding the token check, the unconfigured `404`, the `FLOOR_WARDEN_UNAVAILABLE` answer, the handler call and the error mapping. Replace the inline block in `http-server.mjs` with a call to the gate built with `distinguishEndpointPrincipal: true` and a matcher built from the env token. Keep steps 3 to 10 in `floor-warden-replies.mjs` unchanged.

- [ ] **Step 6: Run to confirm pass**

Run each file one at a time.

```bash
timeout 60 node --test sigil/relay/v1/floor-warden-gate.test.mjs
timeout 60 node --test sigil/relay/v1/floor-warden-replies.test.mjs
```

Expected: PASS with no change to existing assertions. Run `timeout 60 node --test sigil/relay/v1/floor-warden-e2e.pg.test.mjs` with `SIGIL_TEST_DATABASE_URL` set and record the counts.

- [ ] **Step 7: Commit**

```bash
git add sigil/relay/v1/floor-warden-gate.mjs sigil/relay/v1/floor-warden-gate.test.mjs sigil/relay/v1/http-server.mjs sigil/relay/v1/floor-warden-replies.test.mjs
git commit -m "refactor(sigil): move the Floor Warden reply gate into a shared module"
```

---

### Task 7: Reply ingress listener

**Files:**
- Create: `relay/v1/reply-ingress.mjs`, `relay/v1/reply-ingress.test.mjs`

**Interfaces:** Produces `createReplyIngress`. Consumes the gate from Task 6 and the matcher from Task 4. Limits are stubs here and become real in Task 8.

- [ ] **Step 1: Write failing route table tests**

Use a stub gate, a stub limiter that always allows, and a stub per-bot limiter. Drive the server on an ephemeral port. Table rows (method and path) that must each answer the identical fixed `404` body bytes with code `NOT_FOUND`:

- `GET /`, `GET /v1/rooms`, `GET /v1/rooms/room_x/replies`, `PUT /v1/rooms/room_x/replies`, `HEAD /v1/rooms/room_x/replies`, `OPTIONS /v1/rooms/room_x/replies`.
- `POST /v1/rooms/room_x/replies/` (trailing slash), `POST //v1/rooms/room_x/replies`, `POST /v1/rooms%2Froom_x/replies`, `POST /v1/rooms/room_x%2Freplies`, with `%2F` and `%2f` variants, and encoded dot segments such as `/v1/rooms/%2e%2e/replies`.
- `POST /v1/stream` and a WebSocket upgrade attempt to `/v1/stream`.
- A `POST` to the reply path with a query string answers the same as without one when it matches, and the stub gate never sees the query string.

Also assert:

- A matching `POST /v1/rooms/{room_id}/replies` reaches the gate with the decoded room id.
- A room id that fails decoding answers `400 INVALID_REQUEST`.
- No CORS header and no `Access-Control-*` header appears on any answer.
- The server reads no `X-Forwarded-For` or provider header (a request carrying them behaves like one without).

- [ ] **Step 2: Write failing order-of-checks tests**

Cases:

- The order is path, ceiling, token, content type, body and timeout, per-bot limit, handler. Use spies to assert the call order.
- A request with a bad token and `Content-Type: text/plain` answers `401`, never `415`.
- A valid token with `Content-Type: text/plain` answers `415`.
- A valid token and a body over 96 KiB answers the status the Task 1 notes recorded for `readBody` and the handler.
- A chunked body that crosses the cap stops at the cap.
- A slow body hits the request timeout (use a short test value for `requestTimeoutMs`) and the connection closes without a handler call.
- A header block over the Node server limit gets the server's own refusal. Record the status the server returns in a comment.

- [ ] **Step 3: Run to confirm failure**

Run: `timeout 60 node --test sigil/relay/v1/reply-ingress.test.mjs`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement**

Create an `http.Server` with a short keep-alive and a request timeout. Match only `POST` and the reply path pattern the main route uses (read `http-server.mjs` for the pattern). Send one fixed `404` for everything else, and set no CORS headers. Register no `upgrade` handler so upgrade attempts get the fixed `404`, and record in the test what Node does with an upgrade request that has no handler. Return `{ server, listen(port) }`, binding `127.0.0.1` only.

- [ ] **Step 5: Run to confirm pass**

Run: `timeout 60 node --test sigil/relay/v1/reply-ingress.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sigil/relay/v1/reply-ingress.mjs sigil/relay/v1/reply-ingress.test.mjs
git commit -m "feat(sigil): add the reply ingress listener with one route and a fixed 404"
```

---

### Task 8: Limits and metrics

**Files:**
- Modify: `relay/v1/reply-ingress.mjs`, `relay/v1/relay-config.mjs` (defaults: ingress 120 per minute, per-bot 30 per minute)
- Create: `relay/v1/reply-ingress-limits.test.mjs`

**Interfaces:** Produces the ingress ceiling, the per-bot limiter and the counters. Consumes `reserveRateLimit` with scope kind `floor_warden_reply` and `createRelayMetrics`. Read `relay/v1/relay-config.mjs` and the `createRelayMetrics` module first, and record where the defaults and counters fit.

- [ ] **Step 1: Write failing tests**

Use an injectable clock and spies.

- Ceiling. The 121st request in one minute answers `429 RATE_LIMITED` with a `Retry-After` header in the unit the Task 1 notes recorded. Spies show no body read and no repository call for the refused request. The bucket refills with the clock.
- Per-bot limit. After a token matches, the limiter calls `repository.reserveRateLimit('floor_warden_reply', botId, windowStart, 30)` with `windowStart` from `Math.floor(ms/60000)` minute buckets. The 31st request in a minute answers `429 RATE_LIMITED`, and the next minute bucket recovers.
- Fail closed. A limiter that throws answers `503` and writes nothing (assert nothing was inserted). A repository with no `reserveRateLimit` answers `503` and writes nothing.
- A `global` match has no bot id. Record in the test how the per-bot limit treats it and make the rule match the spec (the global token only works with the flag).
- Counters `sigil_ingress_requests_total{result}`, `sigil_ingress_auth_failed_total` and `sigil_ingress_rate_limited_total{scope}` increment on the matching events. The `scope` label is `ingress` or `bot`.
- Auth-failure log lines aggregate to at most one per 10 s with a count (injectable clock). The aggregated line carries the count and no token.
- No log line contains the token, the query string, the body or the text.

- [ ] **Step 2: Run to confirm failure**

Run: `timeout 60 node --test sigil/relay/v1/reply-ingress-limits.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add an in-memory token bucket with an injectable `now`, checked right after the path match and before any body read or repository call. Add the per-bot limiter after the body read. Add defaults 120 and 30 to `relay-config.mjs`. Wire the counters through `createRelayMetrics`. Aggregate auth-failure log lines on a 10 s window.

- [ ] **Step 4: Run to confirm pass**

Run: `timeout 60 node --test sigil/relay/v1/reply-ingress-limits.test.mjs`
Then rerun `timeout 60 node --test sigil/relay/v1/reply-ingress.test.mjs` to confirm no regression.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/reply-ingress.mjs sigil/relay/v1/relay-config.mjs sigil/relay/v1/reply-ingress-limits.test.mjs
git commit -m "feat(sigil): add ingress ceiling, per-bot limit, fail-closed 503, and counters"
```

---

### Task 9: `relay up` flags, startup validation, ports and kill switch

**Files:**
- Modify: `cli/sigil.mjs` (parseArgs options at the `relay up` call near line 206, validation near lines 327 to 345 and 363 to 410, listen block, startup banner, help text near line 65)
- Create: `cli/relay-up-ingress.test.mjs`

**Interfaces:** Produces `--ingress-origin`, `--ingress-port`, `--ingress-rate-per-minute` and `--ingress-allow-global-token`. Consumes Tasks 4, 6, 7 and 8.

- [ ] **Step 1: Read the existing tests**

Read `cli/relay-up-flags.test.mjs` and the free-port helper in `relay/v1/oauth/relay-up.pg.test.mjs`. Record how they spawn `relay up` and how they wait for exit.

- [ ] **Step 2: Write failing tests**

Model the file on `cli/relay-up-flags.test.mjs`. Fail-closed cases (the relay exits 1, nothing listens, and the message names the flag and never a secret value):

- `--ingress-origin` that is `http://...`, has a path, a query, a port-less non-https scheme, or is not a URL.
- `--ingress-origin` without `--database-url` or without `--room-bot-key-wrap-key`.
- `--port 0` together with `--ingress-origin`.
- The relay, stream, public and ingress ports not four distinct values. The message prints the four ports and the 8793 overlap hint.
- `--ingress-rate-per-minute` of `0`, `-1`, `1.5` and `abc`.

Success cases:

- A valid `--ingress-origin` with distinct ports binds the ingress on `127.0.0.1` only (assert the bind address) at `--port` plus 3 by default and at `--ingress-port` when given.
- The startup banner prints the ingress origin and local port.
- `--ingress-allow-global-token` adds a warning line to the banner. Without the flag, no warning prints.

Kill switch and help:

- Without `--ingress-origin`, no ingress listener exists. Connect to the would-be port and assert it is closed.
- The help text lists the four new flags.

Use an ephemeral free-port helper for any test that needs a live port. Retry timing-flaky relay-up tests once.

- [ ] **Step 3: Run to confirm failure**

Run: `timeout 60 node --test sigil/cli/relay-up-ingress.test.mjs`
Expected: FAIL.

- [ ] **Step 4: Implement**

Add the four options to the `parseArgs` call and the help text. Add the validation block next to the existing relay validation, before any listen call, so nothing binds on a failed check. Build the ingress with `createReplyIngress`, a matcher from `createReplyTokenMatcher` (with `allowGlobal` from the flag and `globalTokens` from the existing `loadReplyTokens` result), and the gate with `distinguishEndpointPrincipal: false`. Start it after the other listeners and close it with them. Bind `127.0.0.1` only.

- [ ] **Step 5: Run to confirm pass**

Run: `timeout 60 node --test sigil/cli/relay-up-ingress.test.mjs`
Then run `timeout 60 node --test sigil/cli/relay-up-flags.test.mjs` to confirm no regression.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sigil/cli/sigil.mjs sigil/cli/relay-up-ingress.test.mjs
git commit -m "feat(sigil): add relay up ingress flags, fail-closed startup checks, and the kill switch"
```

---

### Task 10: Bridge https-only reply URL

**Files:**
- Modify: `cli/sigil.mjs` (the Floor Warden bridge config near lines 1090 to 1140, the reply URL check), `cli/agent-run-floor-warden.test.mjs`

**Interfaces:** Changes the `--floor-warden-reply-url` check in `sigil agent run --room-bridge floor-warden`.

- [ ] **Step 1: Read the existing tests and the check**

Read `cli/agent-run-floor-warden.test.mjs` and the reply URL check in `cli/sigil.mjs`. Record which loopback http cases exist today and must keep passing.

- [ ] **Step 2: Write failing tests**

Add cases to `cli/agent-run-floor-warden.test.mjs`.

- An `https://` reply URL is accepted.
- An `http://` reply URL to a public host is refused. The error names `--floor-warden-reply-url` and contains no part of the URL value.
- An `http://127.0.0.1:...`, `http://localhost:...` and `http://[::1]:...` reply URL is accepted.
- A malformed URL is refused, and the error contains no URL value.
- The existing loopback http cases still pass.

- [ ] **Step 3: Run to confirm failure**

Run: `timeout 60 node --test sigil/cli/agent-run-floor-warden.test.mjs`
Expected: FAIL on the public http case.

- [ ] **Step 4: Implement**

Replace the check so `http:` passes only for `127.0.0.1`, `localhost` and `[::1]`, and `https:` passes for any host. Keep the error text free of the URL value.

- [ ] **Step 5: Run to confirm pass**

Run: `timeout 60 node --test sigil/cli/agent-run-floor-warden.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sigil/cli/sigil.mjs sigil/cli/agent-run-floor-warden.test.mjs
git commit -m "feat(sigil): refuse an http Floor Warden reply URL unless the host is loopback"
```

---

### Task 11: `sigil ingress status` and `sigil ingress doctor`

**Files:**
- Create: `cli/ingress-commands.mjs`, `cli/ingress-commands.test.mjs`, `cli/ingress-commands.pg.test.mjs`
- Modify: `cli/sigil.mjs` (usage and dispatch)

**Interfaces:** Produces `sigil ingress status` and `sigil ingress doctor --origin <url> [--access-client-id-env N --access-client-secret-env N] [--relay-port N --stream-port N --public-port N --ingress-port N]`. Consumes `listReplyTokens` and `countAcceptedReplies` from Task 3. Read `cli/doctor.mjs` first and record how it probes and prints, so the new command matches its style.

Doctor computes the four ports with the `relay up` defaults, reports any two that are equal, and prints the 8793 hint on overlap. Doctor does not check the global token flag and does not check loopback binding. The relay prints the global token warning at startup (Task 9).

- [ ] **Step 1: Write failing doctor tests with a fake fetch**

Doctor takes an injectable `fetch`. Cases:

- An unauthenticated `POST` to `/v1/rooms/room_doctor/replies` that gets a Sigil-shaped `401` with code `UNAUTHENTICATED` passes.
- `GET /` and `GET /v1/rooms` that get `404` pass. A `200` or a `401` on those paths fails.
- A response without a `code` field on any probe (the edge answered) reports "blocked at the edge, the Sigil gate was not reached" and is not a pass.
- A certificate error from `fetch` is reported as a certificate failure.
- With `--access-client-id-env` and `--access-client-secret-env`, the two Cloudflare Access service-token headers are sent on every probe, with values read from the named environment variables. The values appear in no printed line and no argv.
- A named environment variable that is unset fails before any probe and names the variable, never a value.
- Doctor never sends an `Authorization` reply token header.
- Port overlap. With no port flags, doctor computes the `relay up` defaults (relay 8791, stream 8792, public 8793, ingress 8794) and reports no overlap. When any two of the four values from `--relay-port`, `--stream-port`, `--public-port` and `--ingress-port` are equal, doctor reports the equal pair and prints the 8793 hint. A case with the public port and the ingress port both at 8793 and a case with two other equal ports both report the overlap.

- [ ] **Step 2: Write the failing status pg test**

In `cli/ingress-commands.pg.test.mjs` (disposable database), provision the fixture bot and two tokens (one active, one retired), record one accepted and one refused reply audit row, and run status. Assert the output lists tokens per bot with status, age and `last_used_at`, shows the accepted count for the last hour (and not the refused row), and never prints a hash or a token.

- [ ] **Step 3: Run to confirm failure**

Run: `timeout 60 node --test sigil/cli/ingress-commands.test.mjs`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement**

Create `cli/ingress-commands.mjs` with `cmdIngressStatus` and `cmdIngressDoctor`. Doctor tells an edge answer from a Sigil answer by the standard error shape (a `code` field in the JSON body). Wire both into the dispatcher and usage text in `cli/sigil.mjs`.

- [ ] **Step 5: Run to confirm pass**

Run: `timeout 60 node --test sigil/cli/ingress-commands.test.mjs`
Then, with `SIGIL_TEST_DATABASE_URL` set, run `timeout 60 node --test sigil/cli/ingress-commands.pg.test.mjs`.
Expected: PASS. Record the pass and skip counts of the pg file.

- [ ] **Step 6: Commit**

```bash
git add sigil/cli/ingress-commands.mjs sigil/cli/ingress-commands.test.mjs sigil/cli/ingress-commands.pg.test.mjs sigil/cli/sigil.mjs
git commit -m "feat(sigil): add sigil ingress status and doctor"
```

---

### Task 12: Postgres evidence tests over real HTTP

**Files:**
- Create: `relay/v1/reply-ingress.pg.test.mjs`

**Interfaces:** Exercises Tasks 2 to 9 together. Read `relay/v1/floor-warden-e2e.pg.test.mjs` first and record its harness shape (relay start, fixture bot provisioning, room and invocation setup).

- [ ] **Step 1: Write the harness**

Start a real relay on a disposable Postgres with the ingress enabled on an ephemeral port, using `createReplyIngress` the same way Task 9 wires it. Provision the fixture bot `ep_test_bot` with bot id `bot_test`, a disposable room, and a running invocation. Create tokens through the Task 3 repository methods. No real bot ids appear.

- [ ] **Step 2: Write the failing cases**

- Happy path answers `202`. A duplicate with the same `idempotency_key` answers `202` with `duplicate: true`.
- A token for a different bot answers `403 BOT_NOT_ON_ROSTER`. A revoked token answers `401`.
- A retired token inside its grace window answers `202`, and after `expires_at` answers `401`.
- A normal endpoint bearer answers `401` with no endpoint lookup (spy on the authenticator).
- The global token answers `401`, and answers `202` only when the relay runs with `--ingress-allow-global-token`.
- Per-bot `429` after the limit, then recovery in the next minute bucket (inject the clock or use a small limit).
- Ingress ceiling `429` before any database query (spy on the pool).
- A limiter failure answers `503` and no row is written.
- Database down answers `503`, then recovery with the same `idempotency_key` answers `202`.
- A stale `in_reply_to` answers `403 ROOM_NOT_INVOKED`. Stop followed by a late reply answers `403 ROOM_NOT_INVOKED`.
- The cookie-only listener still answers `401` to a bearer-only reply POST.
- Secrets are absent from relay logs, audit rows and every response body.

- [ ] **Step 3: Run to confirm failure where the wiring is missing**

Run: `SIGIL_TEST_DATABASE_URL=... timeout 180 node --test sigil/relay/v1/reply-ingress.pg.test.mjs`
Expected: FAIL on any case Tasks 2 to 9 left unwired. If every case already passes, record that in the PR and continue. Fix a failing layer in its own task's files, not in the test.

- [ ] **Step 4: Run to confirm pass**

Run: `SIGIL_TEST_DATABASE_URL=... timeout 180 node --test sigil/relay/v1/reply-ingress.pg.test.mjs`
Expected: PASS. Record the pass count and the skip count. A skipped case is not evidence.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/reply-ingress.pg.test.mjs
git commit -m "test(sigil): prove the reply ingress over real HTTP on a disposable Postgres"
```

---

### Task 13: End to end through the loopback TLS proxy

**Files:**
- Create: `relay/v1/floor-warden-ingress-e2e.pg.test.mjs`

**Interfaces:** Exercises Tasks 5 to 12 together. Read `relay/v1/floor-warden-e2e.pg.test.mjs` and `integration/fixtures/loopback-tls-proxy.mjs` first. Record how the proxy takes `relayPort` and which certificate export (`TLS_CERT`) it offers.

- [ ] **Step 1: Write the harness**

Reuse the phase 6 harness shape. Start the relay with `--ingress-origin` equal to the proxy's https origin. Start the loopback TLS proxy with `relayPort` set to the ingress port. Run the Floor Warden bridge with `--floor-warden-reply-url` equal to the https proxy origin. Have the fake Floor Warden call the reply URL over https, passing the fixture certificate (`TLS_CERT`) as `ca` only inside the test. Mint a token with the Task 4 module and give it to the fake through the test's own variable, never through a log.

- [ ] **Step 2: Write the failing scenarios**

- Happy path. A human @mentions the bot, the fake receives the payload, replies through the proxy, the reply lands in the thread, and the invocation completes.
- Duplicate reply. A second call with the same key answers `202` with `duplicate: true`.
- Stale reply answers `403 ROOM_NOT_INVOKED`.
- Timeout. No reply arrives within a short reply timeout, and the room shows `invocation_failed` with `REPLY_TIMEOUT`.
- Token rotation mid-run. After `rotate`, the old token still works inside the grace window and the new token works.
- Revoke, then the next call answers `401`.
- Secrets. The combined relay, bridge and fake logs contain no reply token, relay token or webhook path.

- [ ] **Step 3: Run to confirm the first result**

Run: `SIGIL_TEST_DATABASE_URL=... timeout 180 node --test sigil/relay/v1/floor-warden-ingress-e2e.pg.test.mjs`
Expected: FAIL on any scenario that the earlier tasks left unwired. Fix the failing layer in its own task's files.

- [ ] **Step 4: Run to confirm pass**

Run: `SIGIL_TEST_DATABASE_URL=... timeout 180 node --test sigil/relay/v1/floor-warden-ingress-e2e.pg.test.mjs`
Expected: PASS. Record the pass count and the skip count.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/floor-warden-ingress-e2e.pg.test.mjs
git commit -m "test(sigil): run the reply ingress end to end through the loopback TLS proxy"
```

---

### Task 14: Provider runbook

**Files:**
- Create: `docs/reply-ingress-runbook.md`

**Interfaces:** Closes spec assumption A7 as a documented operator step. Consumes the flags from Task 9 and the commands from Tasks 5 and 11.

- [ ] **Step 1: Write the runbook**

Sections, in this order.

- Purpose.
- What is exposed. One route, `POST /v1/rooms/{room_id}/replies`, on a loopback listener. The relay, stream listener and cookie listener are not exposed.
- Cloudflare Tunnel steps. Pick a dedicated hostname under a Cloudflare-managed domain. Run `cloudflared` as a Windows service with one ingress rule from the hostname to `http://127.0.0.1:<ingress port>`. Add a WAF rate-limiting rule on the hostname. Add an Access application with a Service Auth policy and a service token. State that an identity or email policy must not be used, because it blocks a non-interactive caller. Note that Access cannot enforce on a non-standard port in the URL.
- Tailscale Funnel fallback steps. Run `tailscale funnel` on port 443 against the ingress port, using the `ts.net` name. State that Funnel has no edge auth and no edge rate limit, that its bandwidth limit has no published number, and that anyone with the URL can reach it.
- What never goes in the repo. No hostname, token, service token or account value.
- Rotating tokens, with `sigil bot token rotate --bot-id <id>` and the grace period.
- The kill switch. Restart the relay without `--ingress-origin`. No database change is needed.
- The doctor command, with the two optional `--access-client-id-env` and `--access-client-secret-env` flags.
- A table of symptoms and recovery steps, taken from the spec's failure modes.

Cite the vendor docs URLs listed in the spec for each vendor claim. Mark any step this plan did not verify as "not verified here". Mark the Windows service step for `cloudflared` and `tailscaled` that way.

- [ ] **Step 2: Secret scan**

```bash
node sigil/scripts/secret-scan.mjs
grep -nEi "fwr_[A-Za-z0-9_-]{20,}|bearer [A-Za-z0-9_-]{20,}|\.trycloudflare\.com|\.ts\.net" docs/reply-ingress-runbook.md || echo "no secret patterns"
```

Expected: the scan passes and the grep prints `no secret patterns`. If a vendor domain suffix appears only as a generic example, replace it with a placeholder in angle brackets.

- [ ] **Step 3: Commit**

```bash
git add docs/reply-ingress-runbook.md
git commit -m "docs(sigil): add the reply ingress provider runbook"
```

---

### Task 15: Live transport smoke procedure

**Files:**
- Create: `docs/superpowers/plans/2026-10-17-reply-ingress-smoke-notes.md` (filled in during the run)

**Interfaces:** Consumes the whole ingress and the Task 14 runbook. This is the only task that touches a provider, and only after approval.

- [ ] **Step 1: Check the precondition**

Chris must have approved provider setup in writing and supplied the hostname. If either is missing, stop and report. Do not start a tunnel, do not touch a provider account and do not change DNS. Record the approval date in the notes file without copying the hostname into the repo.

- [ ] **Step 2: Prepare the fixture**

Use a disposable database (name ends in `_test`), the fixture bot `ep_test_bot`, a disposable room and a running fixture invocation. Never use the real bots. Create a smoke token with `sigil bot token create`. Keep the token in an environment variable for the curl calls and never write it to a file or the notes.

- [ ] **Step 3: Start the relay and run doctor**

Start the relay with `--ingress-origin` set to the approved origin. Run `sigil ingress doctor --origin <url>`. Add the two Access flags when Access is in front. Record each doctor check result.

- [ ] **Step 4: Run the curl table from outside the LAN**

Use the Linux box or a phone hotspot. Expected results:

| Call | Expected |
|---|---|
| No token | `401` (or the Access response when Access is on and the service-token headers are absent) |
| Valid token, running invocation | `202` |
| Same body again | `202` with `duplicate: true` |
| Valid token, wrong `target_bot_id` | `403` |
| Revoked token | `401` |
| Burst above the per-bot limit | `429` |
| `GET /v1/rooms` | `404` |

Record status codes only. Never record a token, header value or hostname.

- [ ] **Step 5: Clean up**

Revoke the smoke token with `sigil bot token revoke --token-id <id>`. Stop the relay. Confirm the ingress port is closed.

- [ ] **Step 6: Record the results**

Fill in the results table and the doctor results in the notes file. List any result that differs from the expected table as an open finding.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/plans/2026-10-17-reply-ingress-smoke-notes.md
git commit -m "docs(sigil): record the reply ingress live transport smoke results"
```

---

### Task 16: Docs, status and full verification

**Files:**
- Modify: `README.md`, `STATUS.md`, `CHANGELOG.md`, `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md`

**Interfaces:** Closes the phase. `docs/superpowers/specs/2026-10-16-sigil-hybrid-dm-decisions.md` is not modified.

- [ ] **Step 1: Docs edits**

- `README.md`. Add a "Reply ingress" section next to the Floor Warden bridge section. Cover the four relay flags, the `sigil bot token` and `sigil ingress` commands, where secrets live, and the reply contract. Replace the sentence at line 176 that says replies need the phase 7 tunnel with accurate wording that names the ingress and states what stays gated on Chris.
- `STATUS.md`. Add the phase 7 line with the branch name and the open assumptions A1 to A5.
- `CHANGELOG.md`. Add an Unreleased entry for the reply ingress, the token commands and the https-only bridge rule.
- `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md`. Mark phase 7 as split into the tunnel and phase 7b (PWA and Web Push).

- [ ] **Step 2: Run the root suite**

Run once in the background and wait for it to finish.

```bash
timeout 1500 npm test
```

Expected: PASS. Retry timing-flaky tests (inbox-wait, contract-signing, relay-up-*) once. Record result counts.

- [ ] **Step 3: Run the named pg files one at a time**

Set `SIGIL_TEST_DATABASE_URL` to a database whose name ends in `_test`. Run each file alone and record its pass count and skip count.

```bash
timeout 60 node --test sigil/migrations/039_reply_ingress.test.mjs
timeout 60 node --test sigil/relay/v1/floor-warden-reply-tokens.pg.test.mjs
timeout 60 node --test sigil/cli/bot-token-commands.pg.test.mjs
timeout 60 node --test sigil/cli/ingress-commands.pg.test.mjs
timeout 180 node --test sigil/relay/v1/reply-ingress.pg.test.mjs
timeout 180 node --test sigil/relay/v1/floor-warden-ingress-e2e.pg.test.mjs
timeout 180 node --test sigil/relay/v1/floor-warden-e2e.pg.test.mjs
```

Expected: PASS with zero skips. A skipped pg test is not evidence.

- [ ] **Step 4: Secret scan**

```bash
node sigil/scripts/secret-scan.mjs
git diff origin/main --stat
git diff origin/main | grep -nEi "fwr_[A-Za-z0-9_-]{43}|floor_warden_reply_token=|sender_key=|relay_token\"|private_key_pem\"|hooks\.|bearer [A-Za-z0-9_-]{20,}" || echo "no secret patterns"
```

Expected: the scan passes and the grep prints `no secret patterns`. Inspect any match by hand. Confirm the diff does not touch `run-sigil-daemon.ps1` or any `.sigil/*.json` file.

- [ ] **Step 5: Commit**

```bash
git add README.md STATUS.md CHANGELOG.md docs/superpowers/specs/2026-10-02-sigil-rooms-design.md
git commit -m "docs(sigil): document the reply ingress and record phase 7 status"
```

---

## Self-review

- **Spec coverage:**
  - Listener, Tasks 7 and 9. Shared gate, Task 6.
  - Per-bot credentials, Tasks 2 to 5. Limits, Task 8.
  - https only, Tasks 9 and 10. Provider layer, Tasks 14 and 15.
  - Observability, Tasks 8 and 11. Failure modes and recovery, Tasks 5, 9, 11 and 14.
  - Testing and Postgres evidence, Tasks 12 and 13. Rollout, Tasks 15 and 16.
  - Hybrid interaction, no code, spec only. `BRIDGES`, no change, recorded in Task 1.
- **Not in this plan, on purpose:**
  - Signed request mode, and phase 7b PWA and Web Push.
  - Direct message routes, and creating `ep_chief` and `ep_helix_ci`.
  - Copying the routine URL and sender key, and the real Grok smoke.
  - Provider account setup. Tasks 14 and 15 only document and gate it.
  - Metrics export, and any change to `run-sigil-daemon.ps1`.
- **Assumptions the executor must close:**
  - A7 closes in Task 14 and rollout stage 3.
  - A8, A10 and A12 close in Tasks 1 and 2.
  - A9 closes in Tasks 9 and 11.
  - A11 closes in Task 12.
  - A1 to A5 close only at the live Grok smoke, which is outside this plan.
