# Sigil rooms phase 6 (Floor Warden bridge) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Grok Bot app bot (Chief, Helix CI Triage) answer in a Sigil room: forward the invoked room message to the one "Sigil rooms" webhook, accept the answer on `POST /v1/rooms/{room_id}/replies`, and sign it as the bot's own endpoint with a relay-held key. Add the visible loop guards and per-bot catch-up the research asked for.

**Architecture:** Tasks 2-5 add the data, the bot signer and the `sigil bot` CLI. Tasks 6-8 add the reply route in three layers: gate, handler, idempotency and contract. Tasks 9-11 add the payload builder, the outbound bridge and its daemon wiring. Tasks 12-13 add the relay loop guards and the Continue route. Task 14 is an end-to-end run against a fake Floor Warden. Task 15 closes docs and gates. Task 1 settles two facts the design marks as assumptions.

**Tech Stack:** Node `.mjs` with `node:test`, `pg`, Postgres 15, `ws`. TypeScript, React 19 and Vitest in `packages/sigil-rooms-web` (Task 13 only).

**Spec:** `docs/superpowers/specs/2026-10-16-sigil-rooms-phase-6-floor-warden-bridge-design.md` (read it first; this plan cites it as "spec"). Parent: `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md`.

## Global Constraints

- Branch off `origin/main` in a worktree. Never switch branches in `C:\dev\sigil-repo` and never stash, reset or check out over its uncommitted work. No push and no PR unless asked.
- Paths below are relative to `sigil/` unless they start with `packages/` or `docs/`. Relay code is `relay/v1/`, bridges are `bridges/v1/`.
- Unit tests: `timeout 60 node --test <file>`. Postgres tests read `SIGIL_TEST_DATABASE_URL`, skip without it, call `assertDisposableTestDatabase`, and run `applyMigrations(url, { reset: true })`. **Run one `node --test` process at a time.** Overlapping runs deadlock the shared pg.
- Never read, print, copy or commit anything in `.sigil/*.json`. Tests build identities and registries in a temp directory.
- Never create `ep_chief` or `ep_helix_ci`, never run `sigil bot add` against a real database, and never call the real Grok routine. Chris declined endpoint setup for this phase. Tests use fixture ids such as `ep_test_bot`.
- Secrets arrive through environment variable names (`--...-env`), never argv. No test, log line, error message or audit row may contain the reply token, the sender key, the webhook URL, or a wrapped key. Task 11 has the redaction test.
- Migration number is 035 on this checkout (highest is `034_oauth_login.sql`). Re-check with `ls sigil/migrations | tail -3` at execution and renumber if `main` moved.
- Every `INSERT INTO endpoints` sets `kind` explicitly (the column has no default).
- Relay error bodies are `{request_id, code, message, details?}`. Use the `fail()` helper pattern from `room-routes.mjs`.
- Both repositories (`postgres-repository.mjs`, `cli/memory-repository.mjs`) get every new method, as every room method has one.
- Every commit message ends with the `Co-Authored-By` trailer the repo uses for the agent that wrote the commit. Use `test(sigil):` for commits that mainly add tests.
- Files are LF. Before using an edit tool on a file, run `file <path>`; if it reports CRLF, edit with a script that preserves line endings.
- Docs follow the repo's technical-writing rules: sentence case headings, no first-person plural, active voice.

---

## File structure

Relay (`sigil/`):

- Create `migrations/035_floor_warden_bridge.sql` and `migrations/035_floor_warden_bridge.test.mjs`.
- Create `relay/v1/room-bot-signer.mjs` (+ test), `relay/v1/floor-warden-token.mjs` (+ test), `relay/v1/floor-warden-replies.mjs` (+ test and `.pg.test.mjs`).
- Modify `relay/v1/http-server.mjs` (gate), `relay/v1/room-routes.mjs` (continue route, fail and stop events), `relay/v1/room-dispatch.mjs` (cap event), `relay/v1/postgres-repository.mjs`, `cli/memory-repository.mjs`, `cli/sigil.mjs` (flags, `bot` subcommands, `--room-bridge floor-warden`), `contracts/v1/room-event-schema.mjs`, `contracts/v1/relay-api.json`.

Bridge and CLI:

- Create `bridges/v1/floor-warden-payload.mjs` (+ test), `bridges/v1/floor-warden-bridge.mjs` (+ test), `cli/bot-commands.mjs` (+ `.pg.test.mjs`).
- Modify `cli/agent-daemon.mjs` (receive-only identity).

Web (`packages/sigil-rooms-web/src/`): modify `api/client.ts`, `api/types.ts`, `rooms/RowView.tsx`; specs beside them.

Docs: modify `README.md` and `STATUS.md` (Task 15).

## Interfaces fixed up front

```js
// relay/v1/room-bot-signer.mjs
createRoomBotSigner({ repository, wrapKey }) // -> { signForBot(endpointId) -> { privateKey, endpoint } }
// errors: NO_SIGNING_KEY, KEY_MISMATCH, WRAP_KEY_UNAVAILABLE, ENDPOINT_REVOKED
// relay/v1/floor-warden-token.mjs
loadReplyTokens({ env, ref, nextRef }) // -> { matches(bearer) -> boolean } ; throws FLOOR_WARDEN_TOKEN_WEAK
// relay/v1/floor-warden-replies.mjs
handleFloorWardenReply({ request, response, parsedUrl, principal, repository, requestId, now, readBody, tokens, botSigner, buildAcceptOptions, logger }) // -> true when handled
// repository (both implementations)
lookupFloorWardenBot(botId, client)            // -> { bot_id, endpoint_id, display_name, status } | null
insertFloorWardenBot(row, client)
loadWrappedBotSigningKey(keyId, client)        // -> Buffer | null
insertBotSigningKey({ keyId, wrapped, now }, client)
listCapRefusedEndpoints(roomId, threadRootId, client) // -> endpoint_id[] refused for hop_budget since last_reset_at
// resetAgentTurns now also: cap_epoch = cap_epoch + 1, last_reset_at = now; returns the new epoch
// bridges/v1/floor-warden-payload.mjs
buildForwardPayload({ room, bot, invocation, trigger, thread, watermark, replyUrl, turnsLeft, now }) // -> object
buildHaltPayload({ room, bot, invocation, halt, now })                                              // -> object
// bridges/v1/floor-warden-bridge.mjs
createFloorWardenBridge({ identity, relay, sessions, fetchImpl, webhook: { url, key, keyHeader }, replyUrl, replyTimeoutMs, maxAttempts, pollIntervalMs, logger })
// -> { handle({ envelope }), recover(), close() }
```

---

### Task 1: Settle the two unverified facts

**Files:**
- Create: `docs/superpowers/plans/2026-10-16-floor-warden-bridge-verification-notes.md`

**Interfaces:** Produces the answers to spec assumptions 5 and 6, which Tasks 5 and 11 depend on.

- [ ] **Step 1: Check how the relay learns bearer tokens**

```bash
grep -n "tokenHashes\|toTokenHashes\|clearAll\|livenessSnapshot" sigil/cli/sigil.mjs sigil/relay/v1/transport-auth.mjs sigil/relay/v1/admin-notify.mjs
grep -n "relay_token\|registry" sigil/cli/registry-seed.mjs | head -30
```

Record whether a token added to the registry file after startup is honored without a restart, and what `registry-seed.mjs` does with a registry entry that has no local private key.

- [ ] **Step 2: Check the daemon ack rule**

Read `cli/agent-daemon.mjs` from line 185 to 215. Record which `outcome` strings the daemon acks and which it retries. The bridge returns `forwarded`, `failed` and `skipped`.

- [ ] **Step 3: Check `identityKeys` callers**

```bash
grep -rn "identityKeys(identity)" sigil --include=*.mjs | grep -v test
```

List every call that would throw for an identity with no `private_key_pem`. Task 11 makes the daemon's call lazy.

- [ ] **Step 4: Write the notes file**

Three short sections (token loading, daemon ack, identityKeys callers) with file and line references. If step 1 shows a restart is required, add a "restart relay after `bot add`" line that Task 5 prints.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-16-floor-warden-bridge-verification-notes.md
git commit -m "docs(sigil): record token loading and daemon ack facts for the Floor Warden bridge"
```

---

### Task 2: Migration 035

**Files:**
- Create: `migrations/035_floor_warden_bridge.sql`, `migrations/035_floor_warden_bridge.test.mjs`

**Interfaces:** Produces `floor_warden_bots`, `bot_signing_keys`, `room_threads.cap_epoch`, `room_threads.last_reset_at`.

- [ ] **Step 1: Write failing tests**

Model the test on `033_multi_human_foundation.test.mjs`. Cases: all three objects exist after `applyMigrations`; `floor_warden_bots.status` rejects a value outside `active`/`disabled`; `endpoint_id` is unique and must reference `endpoints`; `bot_signing_keys.key_id` must reference `endpoint_keys`; `room_threads.cap_epoch` defaults to 0 on a pre-existing row; re-applying the migration is a no-op.

- [ ] **Step 2: Run to confirm failure**

Run: `timeout 60 node --test sigil/migrations/035_floor_warden_bridge.test.mjs`
Expected: FAIL (tables missing).

- [ ] **Step 3: Write the migration**

Use `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, matching the spec's Data section exactly.

- [ ] **Step 4: Run to confirm pass**

Run: `timeout 60 node --test sigil/migrations/035_floor_warden_bridge.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/migrations/035_floor_warden_bridge.sql sigil/migrations/035_floor_warden_bridge.test.mjs
git commit -m "feat(sigil): add Floor Warden bot, bot signing key, and thread cap epoch schema"
```

---

### Task 3: Repository methods in both repositories

**Files:**
- Modify: `relay/v1/postgres-repository.mjs`, `cli/memory-repository.mjs`
- Create: `cli/memory-repository.floor-warden.test.mjs`, `relay/v1/floor-warden-repository.pg.test.mjs`

**Interfaces:** Produces the five repository methods and the `resetAgentTurns` change listed under "Interfaces fixed up front".

- [ ] **Step 1: Write failing tests (memory)**

Cases: `insertFloorWardenBot` then `lookupFloorWardenBot` round trip; duplicate `bot_id` and duplicate `endpoint_id` each throw `BOT_EXISTS`; a disabled bot still returns with `status: 'disabled'`; `insertBotSigningKey` then `loadWrappedBotSigningKey`; an unknown key returns `null`; `resetAgentTurns` bumps `cap_epoch` by one and sets `last_reset_at`; `listCapRefusedEndpoints` returns only endpoints refused with reason `hop_budget` after `last_reset_at` and de-duplicates.

- [ ] **Step 2: Write the same cases as a Postgres test**

Same names in `floor-warden-repository.pg.test.mjs`, behind `assertDisposableTestDatabase`.

- [ ] **Step 3: Run to confirm failure**

Run: `timeout 60 node --test sigil/cli/memory-repository.floor-warden.test.mjs`
Expected: FAIL.

- [ ] **Step 4: Implement in both repositories**

Place the new methods after `loadWrappedSigningKey`. In `resetAgentTurns` return the new `cap_epoch` and keep the existing signature. Confirm the existing `memory-repository.invocations.test.mjs` and `room-invocations.pg.test.mjs` still pass.

- [ ] **Step 5: Run to confirm pass**

Run each file above, one at a time, then the two existing invocation tests.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.mjs sigil/cli/memory-repository.floor-warden.test.mjs sigil/relay/v1/floor-warden-repository.pg.test.mjs
git commit -m "feat(sigil): add Floor Warden bot and bot signing key repository methods"
```

---

### Task 4: Bot signer

**Files:**
- Create: `relay/v1/room-bot-signer.mjs`, `relay/v1/room-bot-signer.test.mjs`

**Interfaces:** Produces `createRoomBotSigner`. Mirrors `room-human-signer.mjs`.

- [ ] **Step 1: Write failing tests**

Use a fake repository. Cases: a wrapped key round trip yields a private key whose public half matches the registered key; the signer reads `bot_signing_keys` only (a key stored through `loadWrappedSigningKey` for a human is not found); an inactive endpoint throws `ENDPOINT_REVOKED`; a kind other than `agent` throws `NO_SIGNING_KEY`; no active key throws `NO_SIGNING_KEY`; a missing wrap key throws `WRAP_KEY_UNAVAILABLE`; a stored key that does not match the registered public key throws `KEY_MISMATCH`; the wrong wrap key and a swapped `endpointId` (AAD) both fail to unwrap; trust state is re-read on every call (revoke between two calls, second call throws) while the key-match check is memoized; error messages name endpoint ids and never key material.

- [ ] **Step 2: Run to confirm failure**

Run: `timeout 60 node --test sigil/relay/v1/room-bot-signer.test.mjs`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Reuse `unwrapPrivateKey` from `key-wrap.mjs` and `repository.lookupTrustedEndpoint`. Return `{ privateKey, endpoint: { owner_id, endpoint_id, key_id, kind: 'agent' } }`.

- [ ] **Step 4: Run to confirm pass**

Run: `timeout 60 node --test sigil/relay/v1/room-bot-signer.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/room-bot-signer.mjs sigil/relay/v1/room-bot-signer.test.mjs
git commit -m "feat(sigil): add relay-held bot signer with its own key table and wrap key"
```

---

### Task 5: `sigil bot add` and `sigil bot disable`

**Files:**
- Create: `cli/bot-commands.mjs`, `cli/bot-commands.pg.test.mjs`
- Modify: `cli/sigil.mjs` (subcommand routing and usage text)

**Interfaces:** Produces `cmdBotAdd(argv)` and `cmdBotDisable(argv)`. Consumes Tasks 3-4 and `provisionHumanTx`-style transactions from `relay/v1/provision-human.mjs`.

- [ ] **Step 1: Write failing Postgres tests**

Run against a disposable database with a temp directory for identity output. Cases: `bot add` creates an `endpoints` row (`kind='agent'`, owner from the operator identity), an active `endpoint_keys` row, a `bot_signing_keys` row whose wrapped key unwraps to the registered public key, and a `floor_warden_bots` row, all in one transaction; a failure after the first insert leaves nothing behind; a duplicate bot id or endpoint is refused with a clear message; the written identity file has `relay_token`, `endpoint_id`, `owner_id`, `kind` and `receive_only: true` and contains no `private_key_pem` anywhere; the private key appears in no output line; `bot disable` sets `status='disabled'` and is idempotent; a missing wrap key env var fails before any write.

- [ ] **Step 2: Run to confirm failure**

Run: `timeout 60 node --test sigil/cli/bot-commands.pg.test.mjs`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Follow `cmdHumanAdd` for argument parsing, `loadWrapKey` for the key, and one `repository.withTransaction`. Generate the Ed25519 pair in memory and wrap it with `wrapPrivateKey`. Make the relay token with `crypto.randomBytes(24).toString('base64url')`, the length `createIdentity` uses. Register the endpoint the way Task 1's notes say, and print a "restart the relay" line if they say a restart is needed. Print the bot id, endpoint id and identity file path only.

- [ ] **Step 4: Wire the subcommands**

Add `bot add` and `bot disable` to the dispatcher and the usage text in `sigil.mjs`.

- [ ] **Step 5: Run to confirm pass**

Run: `timeout 60 node --test sigil/cli/bot-commands.pg.test.mjs`
Expected: PASS. The tests must not run `bot add` with `ep_chief` or `ep_helix_ci`.

- [ ] **Step 6: Commit**

```bash
git add sigil/cli/bot-commands.mjs sigil/cli/bot-commands.pg.test.mjs sigil/cli/sigil.mjs
git commit -m "feat(sigil): add sigil bot add and disable for relay-held bot endpoints"
```

---

### Task 6: Reply token loader and the reply route gate

**Files:**
- Create: `relay/v1/floor-warden-token.mjs`, `relay/v1/floor-warden-token.test.mjs`
- Modify: `relay/v1/http-server.mjs`, `cli/sigil.mjs` (relay flags)

**Interfaces:** Produces `loadReplyTokens`, the route gate placed before the bearer gate (next to the AgentMail ingress), and the three relay flags.

- [ ] **Step 1: Write failing token tests**

Cases: a token under 32 characters throws `FLOOR_WARDEN_TOKEN_WEAK`; an unset environment variable throws `FLOOR_WARDEN_TOKEN_UNSET` naming the variable, never a value; `matches` is true for the token and false for a near miss, an empty string and a different length; with a second name both tokens match; the module keeps no plain token (assert on the returned object's enumerable properties and a `JSON.stringify`).

- [ ] **Step 2: Write failing gate tests**

In `floor-warden-replies.test.mjs` (the handler tests grow in Task 7), using a stub handler: route not configured answers `404` for any bearer; reply token continues to the handler; a valid endpoint bearer (human and agent) answers `403 ROUTE_NOT_AUTHORIZED`; no header and a wrong header answer `401 UNAUTHENTICATED`; the gate runs before the generic bearer gate (a reply token is not an endpoint token); other paths are untouched.

- [ ] **Step 3: Run to confirm failure**

Run: `timeout 60 node --test sigil/relay/v1/floor-warden-token.test.mjs`
Expected: FAIL.

- [ ] **Step 4: Implement**

Hash with SHA-256 and compare digests with `crypto.timingSafeEqual`. In `createRelayServer` accept `floorWardenReplies` (handler plus tokens) and match `^/v1/rooms/([^/]+)/replies$` with POST before the bearer gate. Add `--floor-warden-reply-token-env`, `--floor-warden-reply-token-next-env` and `--room-bot-key-wrap-key` to `cmdRelayUp`, its `parseArgs` options and the usage text. The route stays absent unless the first flag is set. Never log the `Authorization` header.

- [ ] **Step 5: Run to confirm pass**

Run the two test files above, one at a time, plus `relay-up-flags.test.mjs`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sigil/relay/v1/floor-warden-token.mjs sigil/relay/v1/floor-warden-token.test.mjs sigil/relay/v1/http-server.mjs sigil/relay/v1/floor-warden-replies.test.mjs sigil/cli/sigil.mjs
git commit -m "feat(sigil): add the Floor Warden reply token and the reply route gate"
```

---

### Task 7: Reply handler

**Files:**
- Create: `relay/v1/floor-warden-replies.mjs`
- Modify: `relay/v1/floor-warden-replies.test.mjs`, `relay/v1/http-server.mjs` (wire the handler)

**Interfaces:** Produces `handleFloorWardenReply` covering spec "Reply route" steps 3-6, 8, 9 and 10. Idempotency (step 7, which runs before the invocation check at step 8) is Task 8.

- [ ] **Step 1: Write failing tests**

Use the memory repository with a seeded room, an agent member for the bot endpoint, a running invocation, and an injected bot signer. One test per row:

- `400 INVALID_REQUEST`: unknown field; `room_id` differing from the path; missing `target_bot_id`, `sender`, `in_reply_to` or `idempotency_key`; `text` empty after trim; `text` of 16001 characters (16000 passes); `idempotency_key` of 0 and 129 characters; malformed JSON; body over 96 KiB.
- `403 BOT_NOT_ON_ROSTER`: unknown bot id; disabled bot; `sender` that is not the bot's endpoint.
- `404 ROOM_NOT_FOUND`; `403 BOT_NOT_A_MEMBER` (bot endpoint removed from the room).
- `404 MESSAGE_NOT_FOUND` for an unknown `in_reply_to`.
- `403 ROOM_NOT_INVOKED`: no running invocation; running invocation whose trigger is a different message in the same thread.
- `503 BOT_SIGNING_UNAVAILABLE`: signer throws `NO_SIGNING_KEY`, `KEY_MISMATCH` or `WRAP_KEY_UNAVAILABLE`. `403 ENDPOINT_REVOKED` for a revoked bot.
- `500 INTERNAL` when accept answers `401 INVALID_SIGNATURE`.
- Success: `202` with `request_id`, `message_id`, `room_seq`, `duplicate: false`; the stored envelope is a `room.message` from the bot endpoint with `kind: 'agent'`, empty `mentions`, `thread_root_id` equal to the trigger's thread root, `correlation_id` equal to `in_reply_to`, and a signature that verifies against the bot's registered key; the invocation is `completed` with `reply_message_id` set; the next queued invocation for the bot is promoted; humans get a `room.updated` frame.
- A reply to a trigger that is itself a thread reply lands in the original thread root.

- [ ] **Step 2: Run to confirm failure**

Run: `timeout 60 node --test sigil/relay/v1/floor-warden-replies.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

Follow `room-routes.mjs` lines 150-202 (human send) for the `LocalOutbox` signing and `acceptEnvelopeAsync` call, with `kind: 'agent'` and the check order from the spec. Use `validateRoomMessageBody` on the built body. Use `threadRootOf` from `room-dispatch.mjs` and `repository.lookupRunningInvocation`. Wire the handler into `createRelayServer` and `cmdRelayUp` with the bot signer built from `--room-bot-key-wrap-key`.

- [ ] **Step 4: Run to confirm pass**

Run: `timeout 60 node --test sigil/relay/v1/floor-warden-replies.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/floor-warden-replies.mjs sigil/relay/v1/floor-warden-replies.test.mjs sigil/relay/v1/http-server.mjs sigil/cli/sigil.mjs
git commit -m "feat(sigil): accept Floor Warden replies and sign them as the bot endpoint"
```

---

### Task 8: Reply idempotency, audit row and contract

**Files:**
- Modify: `relay/v1/floor-warden-replies.mjs`, `contracts/v1/relay-api.json`, `contracts/v1/relay-api.test.mjs`
- Create: `relay/v1/floor-warden-replies.pg.test.mjs`

**Interfaces:** Completes spec "Reply route" step 7 and the audit rule. Insert the lookup before the running-invocation check that Task 7 wrote. Adds the route to the contract.

- [ ] **Step 1: Write failing tests**

- Replay of the same key returns `202` with the first `message_id` and `room_seq` and `duplicate: true`, writes no second envelope, and does not require a running invocation (the first reply completed it, so the lookup must run before the `ROOM_NOT_INVOKED` check).
- A replay with different `text` still returns the first result.
- The same key in two rooms does not collide (key scope includes the room).
- A second reply under a new key after completion answers `403 ROOM_NOT_INVOKED`.
- Racing duplicates: two concurrent calls with one key produce one envelope and two `202` answers, one with `duplicate: true` (Postgres test, using the `DUPLICATE_MESSAGE` re-read path from the human send route).
- Audit: one `room.floor_warden_reply` row per accepted or refused call with bot id, endpoint id, room id, message id and outcome; a `JSON.stringify` of every audit row and every logged line from the run contains neither the token nor the reply text.
- Contract: `relay-api.json` has the route with the success and error codes from the spec, including `ROOM_NOT_INVOKED`, `BOT_SIGNING_UNAVAILABLE` and `ENDPOINT_REVOKED`, and `relay-api.test.mjs` checks the entry.

- [ ] **Step 2: Run to confirm failure**

Run: `timeout 60 node --test sigil/relay/v1/floor-warden-replies.test.mjs` then `timeout 60 node --test sigil/relay/v1/floor-warden-replies.pg.test.mjs`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

Store the key as `room:<room_id>:fw_reply:<key>` under the bot endpoint with the repository's idempotency methods, and re-read the winner on `DUPLICATE_MESSAGE`, as `room-routes.mjs` lines 161-196 do. Write the audit row with `repository.recordAuditEvent`.

- [ ] **Step 4: Run to confirm pass**

Run both files above, then `timeout 60 node --test sigil/contracts/v1/relay-api.test.mjs`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/floor-warden-replies.mjs sigil/relay/v1/floor-warden-replies.test.mjs sigil/relay/v1/floor-warden-replies.pg.test.mjs sigil/contracts/v1/relay-api.json sigil/contracts/v1/relay-api.test.mjs
git commit -m "feat(sigil): make Floor Warden replies idempotent, audited, and part of the contract"
```

---

### Task 9: Payload builder

**Files:**
- Create: `bridges/v1/floor-warden-payload.mjs`, `bridges/v1/floor-warden-payload.test.mjs`

**Interfaces:** Produces `buildForwardPayload` and `buildHaltPayload`, pure functions.

- [ ] **Step 1: Write failing tests**

- The forward payload matches the spec's shape field for field, with `schema: 'sigil.floor_warden/1'`, `delivery_key` equal to the invocation id, and `reply.idempotency_key` equal to `<trigger id>:<bot id>`.
- `thread` keeps only messages with `room_seq` above the watermark, at most 20, each clipped to 4000 characters, oldest first; the trigger is not in `thread`.
- No watermark gives `catch_up.reset: true`; a watermark gives `from_seq` and `reset: false`.
- Over 256 KiB drops the oldest `thread` entries and sets `truncated: true`; `trigger.text` is never clipped.
- `untrusted_fields` lists `trigger.text` and `thread[].text`.
- The payload contains no key named `subject_human_id`, `token`, `relay_token` or `key`, checked by a recursive key walk.
- Message text with `<`, `>` and control characters passes through as JSON strings, unchanged.
- The halt payload has `type: 'halt'`, `delivery_key: 'halt:<invocation id>'` and the `halt` object, and no thread.

- [ ] **Step 2: Run to confirm failure**

Run: `timeout 60 node --test sigil/bridges/v1/floor-warden-payload.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

Keep both functions free of I/O and clocks (take `now` as an argument).

- [ ] **Step 4: Run to confirm pass**

Run: `timeout 60 node --test sigil/bridges/v1/floor-warden-payload.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/bridges/v1/floor-warden-payload.mjs sigil/bridges/v1/floor-warden-payload.test.mjs
git commit -m "feat(sigil): add the Floor Warden bridge payload builder"
```

---

### Task 10: Outbound bridge

**Files:**
- Create: `bridges/v1/floor-warden-bridge.mjs`, `bridges/v1/floor-warden-bridge.test.mjs`

**Interfaces:** Produces `createFloorWardenBridge`. Reuses `session-store.mjs` and the `relay` client methods `listRoomInvocations`, `listRoomMembers`, `listRoomMessages` and `failRoomInvocation`.

- [ ] **Step 1: Write failing tests**

Use a fake relay, a fake `fetch`, a temp session store and fake timers.

- Skips (`skipped`, no POST) when the relay has no running invocation for this endpoint and trigger.
- `2xx`: one POST with the payload, the sender key in the configured header (default `Authorization: Bearer`), `forwarded` returned, the watermark for the thread advanced to the highest sequence read, the invocation not failed.
- `400`, `401`, `403`, `404`, `422`: invocation failed with `FLOOR_WARDEN_REJECTED`, watermark unchanged, no throw.
- `408`, `429`, `500`, `503` and a network error throw, leaving the delivery unacked; the retry sends the same `delivery_key`; the watermark did not advance; after 5 attempts for one invocation the bridge fails it with `FLOOR_WARDEN_UNREACHABLE`.
- No reply URL: fails with `REPLY_URL_UNSET` and makes no POST.
- Reply deadline: after `replyTimeoutMs` with the invocation still running, the bridge calls `failRoomInvocation` with `REPLY_TIMEOUT`; if the invocation completed first, no failure call is made and the timer is cleared.
- `recover()` fails running invocations older than the deadline and re-arms timers for younger ones, and sends a halt frame for any invocation cancelled after its recorded forward whose halt is not yet in the session store.
- Halt: when a forwarded invocation disappears from `running` and its status is `cancelled`, the bridge POSTs one halt frame with `delivery_key: halt:<id>` and the `room_halted` event's `room_seq` and message id, once only; a `completed` invocation sends nothing.
- A thrown `fetch` error message that contains the webhook URL is scrubbed before it reaches the logger or the failure reason.
- `close()` clears all timers.

- [ ] **Step 2: Run to confirm failure**

Run: `timeout 60 node --test sigil/bridges/v1/floor-warden-bridge.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

Model `handle` on `room-bridge.mjs` (`runningFor`, thread context read, the throw-versus-fail rule from its comments). Use `AbortSignal.timeout` for the POST (default 30 seconds). Count attempts per invocation id in memory and in the session store so a restart does not reset them. Poll for halt with the same interval the CLI bridge uses to watch for Stop.

- [ ] **Step 4: Run to confirm pass**

Run: `timeout 60 node --test sigil/bridges/v1/floor-warden-bridge.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/bridges/v1/floor-warden-bridge.mjs sigil/bridges/v1/floor-warden-bridge.test.mjs
git commit -m "feat(sigil): add the Floor Warden outbound bridge with deadline, watermark, and halt frame"
```

---

### Task 11: Daemon wiring, receive-only identity, redaction

**Files:**
- Modify: `cli/agent-daemon.mjs`, `cli/sigil.mjs`
- Create: `cli/agent-run-floor-warden.test.mjs`

**Interfaces:** Produces `--room-bridge floor-warden` and the flags in spec "CLI". Consumes Task 1's notes.

- [ ] **Step 1: Write failing tests**

- `createAgentDaemon` constructs with an identity that has `receive_only: true` and no `private_key_pem`, and delivers a `room.message` to `onRoomMessage`; a `task.request` on a receive-only identity is acked without a reply and without throwing.
- Existing identities behave as before (the existing `agent-daemon.test.mjs` stays green).
- `agent run --room-bridge floor-warden` fails fast with a message naming the missing flag or environment variable (`--floor-warden-url-env`, `--floor-warden-key-env`, `--floor-warden-reply-url`) and never prints a value.
- Redaction: run the bridge with a fake webhook whose URL path and key are random strings. Capture stdout, stderr and the logger. None contains the URL path, the key, or a relay token. The origin may appear.
- `--room-bridge` still accepts `claude`, `codex` and `router`, and the error text lists `floor-warden`.

- [ ] **Step 2: Run to confirm failure**

Run: `timeout 60 node --test sigil/cli/agent-run-floor-warden.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

Make the `identityKeys(identity)` and `LocalOutbox` construction in `agent-daemon.mjs` lazy, built on first use and skipped when `identity.receive_only` is true. Add the new bridge kind in `cmdAgentRun` next to `claude`, `codex` and `router`, reading the URL and key from the named environment variables. Update the usage text.

- [ ] **Step 4: Run to confirm pass**

Run the new test, then `timeout 60 node --test sigil/cli/agent-daemon.test.mjs`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/cli/agent-daemon.mjs sigil/cli/sigil.mjs sigil/cli/agent-run-floor-warden.test.mjs
git commit -m "feat(sigil): run the Floor Warden bridge from sigil agent run with a receive-only identity"
```

---

### Task 12: Visible loop-guard events and pins

**Files:**
- Modify: `contracts/v1/room-event-schema.mjs`, `relay/v1/room-dispatch.mjs`, `relay/v1/room-routes.mjs`
- Create: `relay/v1/room-loop-guards.test.mjs`, `relay/v1/room-loop-guards.pg.test.mjs`

**Interfaces:** Adds `agent_cap_reached`, `room_halted` and `invocation_failed` to `ROOM_EVENT_KINDS`. Consumes `resetAgentTurns` and `cap_epoch` from Task 3.

- [ ] **Step 1: Write failing tests**

- Schema: the three kinds validate; an unknown kind still fails; `reason` clamping still applies.
- Cap: with `max_agent_turns` 2, a third agent handoff in one thread is refused with `hop_budget` and the room gets exactly one `agent_cap_reached` event naming the refused endpoint and the cap; a fourth refusal in the same epoch adds `invocation_refused` but no second cap event; after a human post resets the budget and the cap is hit again, a new cap event appears (new epoch). The event commits in the same transaction as the refused row.
- Halt: member removal that cancels work emits `room_halted` with reason `left`, through the same helper.
- Halt: Stop that cancels two invocations emits two `invocation_stopped` events and one `room_halted` event listing both endpoints; Stop that cancels nothing emits no `room_halted`; the event is signed by `ep_relay_system`; a retried Stop does not emit a second one (idempotency key from the cancelled invocation ids).
- Failure: `POST .../invocations/fail` emits `invocation_failed` with the clamped reason; a stale `invocation_id` that matches nothing emits nothing.
- Late reply after halt: a bot reply through the reply route for a cancelled invocation answers `403 ROOM_NOT_INVOKED` (extend the Task 8 harness).
- Pins: an agent-authored `room.message` without mentions creates no router delivery even when a `joins` agent and a router exist; a bot reply with empty `mentions` creates no invocation.

- [ ] **Step 2: Run to confirm failure**

Run: `timeout 60 node --test sigil/relay/v1/room-loop-guards.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add an `emitCapReached` helper beside `emitRefusal` in `room-dispatch.mjs`, called when `dispatchToTarget` returns a `hop_budget` refusal, with idempotency key `evt_cap_<thread_root_id>_<cap_epoch>`. Emit `room_halted` from one helper called at both cancel sites (Stop at `room-routes.mjs` ~line 430 and member removal ~line 250) after the per-invocation events, key `evt_halt_<sorted cancelled ids hashed>`. Emit `invocation_failed` in the fail handler inside its transaction.

- [ ] **Step 4: Run to confirm pass**

Run the unit file, the pg file, then `room-dispatch.test.mjs`, `room-invocations-route.test.mjs` and `room-stop-concurrency.pg.test.mjs`, one at a time.
Expected: PASS, with no change to existing assertions.

- [ ] **Step 5: Commit**

```bash
git add sigil/contracts/v1/room-event-schema.mjs sigil/relay/v1/room-dispatch.mjs sigil/relay/v1/room-routes.mjs sigil/relay/v1/room-loop-guards.test.mjs sigil/relay/v1/room-loop-guards.pg.test.mjs
git commit -m "feat(sigil): post visible cap, halt, and failure events for room invocations"
```

---

### Task 13: Continue route and client button

**Files:**
- Modify: `relay/v1/room-routes.mjs`, `contracts/v1/relay-api.json`, `contracts/v1/relay-api.test.mjs`, `packages/sigil-rooms-web/src/api/client.ts`, `packages/sigil-rooms-web/src/api/types.ts`, `packages/sigil-rooms-web/src/rooms/RowView.tsx`
- Create: `relay/v1/room-continue-route.test.mjs`, `packages/sigil-rooms-web/src/rooms/RowView.continue.spec.tsx`

**Interfaces:** Produces `POST /v1/rooms/{room_id}/continue` and `client.continueThread(roomId, threadRootId)`.

- [ ] **Step 1: Write failing relay tests**

- `404 ROOM_NOT_FOUND` for a non-member; `403 HUMAN_CONTEXT_REQUIRED` for an agent caller or no human id; `503 NO_OPERATOR_IDENTITY` when no human signer is configured.
- `400 INVALID_REQUEST` for a missing `thread_root_id` or `idempotency_key`.
- `409 NOTHING_TO_CONTINUE` when no endpoint was refused for `hop_budget` since `last_reset_at`.
- Success: a signed human `room.message` with text `Continue.`, the caller's endpoint as sender, `thread_root_id` set, and `mentions` equal to the refused endpoints (at most 10); it refills the budget when the caller is the subject of every active invocation; the refused agents are dispatched under the caller; an agent the caller may not invoke yields a visible `invocation_refused` event and not an error.
- Replay of the same `idempotency_key` returns the first result with no second message.

- [ ] **Step 2: Write failing client tests**

`RowView.continue.spec.tsx`: an `agent_cap_reached` row renders its text and a Continue button when `onContinue` is passed; the button calls `onContinue(threadRootId)`; no button without the prop; other event kinds are unchanged. Add `client.continueThread` cases to `client.spec.ts` and the route to `contract.spec.ts`.

- [ ] **Step 3: Run to confirm failure**

Run: `timeout 60 node --test sigil/relay/v1/room-continue-route.test.mjs`
Expected: FAIL.

- [ ] **Step 4: Implement the relay route**

Extend the path regex in `room-routes.mjs` with `continue`. Reuse the human send route's signing and accept code by moving it into one helper that both call, so the two cannot drift. Read refused endpoints with `repository.listCapRefusedEndpoints`. Add the route and its errors to `relay-api.json`.

- [ ] **Step 5: Implement the client**

Add `continueThread` to `api/client.ts`, extend the event body type in `api/types.ts` with the new kinds, and render the button in `RowView.tsx` for `agent_cap_reached` only. Inside `packages/sigil-rooms-web/` run `npm ci --ignore-scripts` first if the worktree is fresh.

- [ ] **Step 6: Run to confirm pass**

Run the relay test and `relay-api.test.mjs`. Then inside `packages/sigil-rooms-web/`: `timeout 300 npm test`.
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add sigil/relay/v1/room-routes.mjs sigil/contracts/v1/relay-api.json sigil/contracts/v1/relay-api.test.mjs sigil/relay/v1/room-continue-route.test.mjs packages/sigil-rooms-web/src
git commit -m "feat(sigil): add the Continue route and a Continue button on the cap row"
```

---

### Task 14: End-to-end run with a fake Floor Warden

**Files:**
- Create: `relay/v1/floor-warden-e2e.pg.test.mjs`

**Interfaces:** Exercises Tasks 5-13 together. Uses no real network service.

- [ ] **Step 1: Write the harness**

Start the relay on a disposable Postgres with the reply token and bot wrap key set through the environment, provision a fixture bot (`ep_test_bot`, `bot_test`) with the Task 5 functions, add it to a room as `mentions_only`, start a fake Floor Warden (`node:http` on `127.0.0.1`, random path and key), and run the Floor Warden bridge for the bot through a real agent daemon with a receive-only identity.

- [ ] **Step 2: Write the scenarios**

- Happy path: a human @mentions the bot. The fake receives one payload with the right fields and the key header. The fake calls the reply route. The reply appears in the trigger's thread at the next `room_seq`, signed by the bot, the invocation completes, and a second call with the same key returns `duplicate: true`.
- Duplicate delivery: the fake receives the payload twice and replies twice with one key. One message is stored.
- Stale reply: the fake replies to an older message while a newer invocation runs. `403 ROOM_NOT_INVOKED`, and the newer invocation is untouched.
- Stop: a human presses Stop while the fake holds the payload. The room shows `invocation_stopped` and `room_halted`, the fake receives a halt frame, and a late reply gets `403 ROOM_NOT_INVOKED`.
- Timeout: no reply within a short `replyTimeoutMs`. The room shows `invocation_failed` with `REPLY_TIMEOUT` and the bot can be invoked again.
- Webhook down: the fake answers `503` five times. `FLOOR_WARDEN_UNREACHABLE` appears in the room.
- Cap: an agent and the bot hand work back and forth until the cap. One `agent_cap_reached` event appears, Continue resumes, and a bot reply never dispatches another agent.
- Disabled bot: after `bot disable`, a reply answers `403 BOT_NOT_ON_ROSTER`.
- Secrets: the combined relay, bridge and fake logs contain no reply token, sender key, webhook path or relay token.

- [ ] **Step 3: Run**

Run: `timeout 120 node --test sigil/relay/v1/floor-warden-e2e.pg.test.mjs`
Expected: PASS. Fix the failing layer in its own task's files, not in the test.

- [ ] **Step 4: Commit**

```bash
git add sigil/relay/v1/floor-warden-e2e.pg.test.mjs
git commit -m "test(sigil): run the Floor Warden bridge end to end against a fake routine"
```

---

### Task 15: Documentation and full verification

**Files:**
- Modify: `README.md` (rooms section), `STATUS.md`, `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md`

**Interfaces:** Closes the phase.

- [ ] **Step 1: README**

Add a short "Floor Warden bridge" section to the rooms part of the root `README.md`: the flow in six lines, the three relay flags, the `sigil bot` commands, the `sigil agent run` flags, the environment variables and where each secret lives, and the statement that replies from Grok's cloud need the phase 7 tunnel. Mention nothing that needs a real bot id.

- [ ] **Step 2: Parent spec and status**

In the parent spec's "Floor Warden reply path" open question, mark the copy-the-URL item as still open and point it at the phase 6 spec. Add the phase 6 line to `STATUS.md` with the branch name and the open assumptions from the spec's Assumptions section.

- [ ] **Step 3: Full verification**

Run the root core suite once, in the background, and wait: `timeout 1500 npm test`. Then inside `packages/sigil-rooms-web/`: `timeout 300 npm test`. Record the result counts in the PR description.
Expected: PASS with no skipped test that was not skipped before (the pg files skip only without `SIGIL_TEST_DATABASE_URL`).

- [ ] **Step 4: Secret scan**

```bash
git diff origin/main --stat
git diff origin/main | grep -nEi "floor_warden_reply_token=|sender_key=|relay_token\"|private_key_pem\"|hooks\.|bearer [A-Za-z0-9_-]{20,}" || echo "no secret patterns"
```

Expected: `no secret patterns`. Inspect any match by hand.

- [ ] **Step 5: Commit**

```bash
git add README.md STATUS.md docs
git commit -m "docs(sigil): document the Floor Warden bridge and record phase 6 status"
```

---

## Self-review

- **Spec coverage:** mapping table (Tasks 2, 3, 5), relay-held signing (4, 5), token and webhook secret storage (6, 11), reply route (6-8), idempotency (8, 10), bridge payload (9), outbound failures, deadline and watermark (10), loop guards (12, 13), CLI (5, 6, 11), tests (every task, Task 14 end to end), Hyperagent deferrals (spec table, no code).
- **Not in this plan, on purpose:** creating `ep_chief` and `ep_helix_ci`, copying the routine URL and sender key, the live Grok smoke test (waits for the phase 7 tunnel), Ironbots requests, bot-authored mentions, cost budgets.
- **Assumptions the executor must close:** spec assumptions 1 (sender key header) and 3 (payload limit) can only be closed against the real routine panel, outside this plan. Assumptions 5 and 6 close in Task 1.
