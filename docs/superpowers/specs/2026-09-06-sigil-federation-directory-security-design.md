# Sigil cross-federation directory — security hardening design

Date: 2026-09-06
Branch: `feat/cross-federation-directory` (off `main` `b11dfc3`, HEAD `a68382e`, not pushed)
Status: design approved, pending implementation plan

## Context

The final whole-branch review of sub-project #4 (cross-federation directory) found
three verified security defects plus one secret-at-rest leak. The branch is not
ship-ready. This document specifies the fixes. Implementation lands on the same
branch, followed by a re-review and `finishing-a-development-branch`. Do not push
until a human-reviewed final step approves it.

The four review findings, as verified against source:

- **B1 — same-owner exemption bypass (Critical).** `accept-federated-envelope.mjs:140`
  takes a directory-gate exemption when `senderOwnerId === recipient.owner_id`.
  `senderOwnerId` comes from `parsedBody.sender_owner_id`, a relay-asserted field
  that is never checked beyond well-formedness. A pinned peer POSTs an envelope
  whose `sender_owner_id` names a local owner on the receiving relay, self-signs
  the propagated `sender_key`, and the exemption delivers the forged envelope into
  that owner's own conversations with no directory link.
- **B2 — redeemer owner-domain unpinned (Important).** `accept-federation-directory.mjs:66`
  applies `parseFederatedId` well-formedness to `redeemer.owner_id` but pins only
  `redeemer.endpoint_id` domain and `redeemer_domain` to `originDomain`. A peer
  holding a valid invite redeems with `redeemer.owner_id` on a domain it does not
  control; the issuer-side link row activates with a foreign `remote_owner_id`.
- **E2 — CLI trusts issuer-response owner ids (Important).** `sigil/cli/sigil.mjs:1089`
  reads `outcome.body.issuer.owner_id` / `.endpoint_id` from the issuer relay's
  202 response and writes them into the redeemer-side link with no check that
  their domain equals `issuerDomain`. A pinned issuer relay injects a
  redeemer-side link naming an arbitrary third-party owner. This is the
  redeemer-side mirror of B2.
- **B3 — no replay protection (Important).** `federation-relay-auth.mjs`
  (`verifyInboundRelayRequest`) parses, resolves the peer by signing kid, and
  verifies an Ed25519 signature. It performs no timestamp, nonce, or freshness
  check. An on-path observer captures one validly signed directory request and
  resends it later: a replayed revocation cuts cross-federation delivery for an
  owner pair; a replayed redemption burns the
  `federation_directory_redemption_inbound` quota for peer griefing. `STATUS.md`
  claims "timestamp, replay, and domain pinning validation", which is currently
  false.
- **Q4 — plaintext invite code (secret at rest).** `sigil federation outbox show <id>`
  (`sigil.mjs:829`) strips `envelope`, `senderKey`, `claimToken`, and `claimedAt`
  from operator output but not `directoryPayload`, which carries the full
  `sigil-fed-invite:<domain>:<link-ref>:<secret>` code. The same code is persisted
  in `federation_outbox.directory_payload` JSONB on the redeemer relay, and
  survives permanently if the row dead-letters. This defeats the hash-at-rest
  design: the `federation_directory_invites` table stores only `code_hash`.

## Non-goals

The following stay out of this spec. They are logged in the SDD ledger as
deferred minors and belong to the final-review cleanup pass:

- Dead `verifyRelaySignature` export in `federation-router.mjs`.
- Dead `initiated_via` column (this spec gives it a writer as a side effect — see
  Section 1 — but does not otherwise audit it).
- Memory-repository vs Postgres-repository parity gaps in the directory methods.
- Migration 018's `ADD CONSTRAINT` lock strategy on `federation_outbox`.
- CLI ergonomics findings (G3, G5, G6).

Migration 018 is not amended. The completed SDD tasks and the live-DB test matrix
reference it as built. All schema changes here go in a new migration 019,
additive only.

## Section 1 — B1: remove the federated same-owner exemption

### Behavior

Remove the exemption branch at `accept-federated-envelope.mjs:140-142`. The
directory-link lookup at lines 143-152 runs unconditionally for every federated
delivery, same-owner and cross-owner alike.

`sender_owner_id` domain is not pinned to `origin_domain`. Sub-project #3's
`--federation-owner` flag deliberately lets one owner id be registered verbatim
on two federated relays with a domain that differs from the relay domain
(`docs/superpowers/specs/2026-08-24-sigil-federated-addressing.md`). Pinning the
domain would break that supported case. `sender_owner_id` remains informational.
The `envelope.sender.owner_id === senderOwnerId` consistency check at line 126
stays.

Cross-federation delivery between two endpoints of the same owner now requires a
**self-pair directory link**: a `federation_directory_links` row whose
`local_owner_id` equals its `remote_owner_id`. The existing invite create and
redeem flow already produces this row when the issuer owner and redeemer owner
are the same string. The only obstruction is a CHECK constraint.

`getActiveFederationDirectoryLink(localOwnerId, remoteOwnerId, remoteDomain)`
(`postgres-repository.mjs:1425`) filters on `status = 'active'` and the owner /
domain triple only — no `role` filter. The envelope-receive lookup
`(recipient.owner_id, senderOwnerId, originDomain)` therefore matches a
self-pair row regardless of whether the receiving relay holds the `issuer` side
(`remote_domain` = redeemer's posting domain) or the `redeemer` side
(`remote_domain` = issuer domain). In both directions the receiver's row carries
`remote_domain` equal to the sender's relay domain, which is `originDomain` on
the receive path. No repository change is needed.

### Schema (migration 019)

Relax `federation_directory_links_distinct_owners`. Drop the current
`CHECK (local_owner_id <> remote_owner_id)` and replace it with:

```sql
ALTER TABLE federation_directory_links
  DROP CONSTRAINT IF EXISTS federation_directory_links_distinct_owners;
ALTER TABLE federation_directory_links
  ADD CONSTRAINT federation_directory_links_distinct_owners
  CHECK (local_owner_id <> remote_owner_id OR initiated_via = 'self_pair');

ALTER TABLE federation_directory_links
  DROP CONSTRAINT IF EXISTS federation_directory_links_initiated_via_check;
ALTER TABLE federation_directory_links
  ADD CONSTRAINT federation_directory_links_initiated_via_check
  CHECK (initiated_via IN ('invite', 'oidc_match', 'self_pair'));
```

This keeps a guard against an accidental self-pair on a link that was not
deliberately created as one, and gives `initiated_via` a real writer.

The table is empty on this pre-GA branch, so the plain `ADD CONSTRAINT` full
scan is acceptable. The migration file records that fact in a comment so a later
reviewer does not re-flag it against finding H5.

The partial unique index `federation_directory_links_live_pair_uidx` on
`(local_owner_id, remote_owner_id, remote_domain) WHERE status IN ('pending','active')`
already prevents duplicate self-pair links.

### CLI and handler

- `sigil federation invite create` and `sigil federation invite redeem` stop
  rejecting the case where the issuer owner equals the redeemer owner.
- `acceptDirectoryRedemption` and the redeemer-side link write in
  `cmdFederationInviteRedeem` set `initiated_via: 'self_pair'` when
  `redeemer.owner_id === invite.issuer_owner_id` (issuer side) or
  `issuer.owner_id === redeemer.owner_id` (redeemer side), and `'invite'`
  otherwise.

### Memory relays

The inbound directory routes (redemption, confirmation, revocation) are
Postgres-gated: `http-server.mjs:193` returns 501 when the repository has no
`enqueueFederationForward`, which `sigil/cli/memory-repository.mjs` does not
implement.

The envelope path is not gated. `memory-repository.mjs` implements both
`getActiveFederationDirectoryLink` (line 565) and `createFederationDirectoryLink`
(line 476), so on a memory relay the directory gate runs and a link row can
exist. Removing the exemption means a memory relay also requires a link row —
self-pair or cross-owner — for federated delivery. A test inserts that row
directly through `createFederationDirectoryLink`; the memory implementation has
no owner-distinctness CHECK, so a self-pair row is accepted without migration
019. Replay state (`federation_relay_nonces`) has no memory-backed durability
guarantee; federation over a memory relay is a development and test
configuration and is not a supported replay configuration. The spec records this
explicitly.

### Ordering

The B1 code change, the migration 019 CHECK relax, and the self-pair CLI / handler
writes are one unit. The B1 "self-pair link authorizes delivery" test cannot pass
until all three land. The implementation plan treats them as a single task, not
three.

## Section 2 — B2 and E2: pin owner-id domains

### B2 — redemption handler

In `accept-federation-directory.mjs`, inside the existing `try` block at lines
65-72 that pins `redeemer.endpoint_id` domain to `originDomain`, add the same
pin for `redeemer.owner_id`:

```js
if (parseFederatedId(redeemer.owner_id).domain.toLowerCase() !== String(originDomain).toLowerCase()) {
  throw new Error('owner domain');
}
```

Failure routes to the existing generic
`400 INVALID_FEDERATION_REQUEST` "redeemer ids are malformed or not on the
posting domain". No new response code.

### E2 — CLI redeem

In `cmdFederationInviteRedeem` (`sigil.mjs`), after
`const issuer = outcome.body?.issuer` and its truthiness check at line 1090, and
before `reserveRateLimit` / `createFederationDirectoryLink`:

- Validate that `parseFederatedId(issuer.owner_id).domain` and
  `parseFederatedId(issuer.endpoint_id).domain` both equal `issuerDomain`,
  case-insensitively.
- On mismatch or parse failure: write a rejected audit event
  (`eventType: 'federation_directory.invite_redeem_rejected'`, `outcome:
  'rejected'`, `reason: 'ISSUER_IDENTITY_DOMAIN_MISMATCH'`, `payload: { peer_domain:
  issuerDomain }`), print a specific `console.error`, set `process.exitCode = 1`,
  and return without reserving quota and without writing the link row.

A pinned issuer relay that returns an owner id on a domain it does not control is
an attack signal, so the rejection is audited rather than silent.

## Section 3 — B3: replay defense

### Approach

Nonce table plus a freshness window on the relay-auth signed body, uniform across
the directory routes and the federation envelope route. Each send attempt signs a
fresh nonce and a fresh `signed_at`. Self-retry double-apply is caught by the
handlers' existing state-idempotency, not by the nonce; the nonce defends only
against external capture-replay. This avoids two collisions that a
stable-nonce-across-retries contract would create:

1. A nonce consumed on a transaction that later rolls back would make a legitimate
   outbox retry look like a replay while no link exists on either side.
2. A stable `signed_at` older than the outbox retry horizon
   (1 minute, then 5 minutes, then 30 minutes, then dead-letter) would fail the
   freshness check on every retry past the window, making any request that does
   not land within the window undeliverable.

Fresh-nonce-per-attempt plus handler state-idempotency dissolves both. There is
no `RELAY_REPLAYED`-means-delivered reaper rule; a self-retry never collides.

### Schema (migration 019)

Mirror `login_jti_replays` (migrations 013 and 015):

```sql
CREATE TABLE IF NOT EXISTS federation_relay_nonces (
  nonce      TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS federation_relay_nonces_expires_at_idx
  ON federation_relay_nonces (expires_at);
```

### Repository

`consumeRelayNonce(nonce, { now = new Date(), expiresAt, client = this.pool })` on
`postgres-repository.mjs`, modelled on `consumeLoginJti` (`postgres-repository.mjs:1023`):

```js
async consumeRelayNonce(nonce, { now = new Date(), expiresAt, client = this.pool } = {}) {
  const expires = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt).toISOString();
  try {
    await client.query('INSERT INTO federation_relay_nonces (nonce, expires_at) VALUES ($1, $2)', [nonce, expires]);
  } catch (error) {
    if (error.code === '23505') throw Object.assign(new Error('relay request nonce already seen'), { code: 'RELAY_REPLAYED' });
    throw error;
  }
}
```

The memory repository gains a `Map<nonce, expiresAt>`-backed equivalent that
throws the same `RELAY_REPLAYED`. It is exercised only by the envelope path on
memory relays; the directory path is Postgres-gated.

Expired-row pruning follows the `login_jti_replays` precedent: the
`expires_at` index is the prune key. No new scheduled job in this spec; a
`DELETE FROM federation_relay_nonces WHERE expires_at < now()` sweep is added to
whatever maintenance path already prunes `login_jti_replays`, or noted as a
follow-up if none exists.

### Signed-body contract

Add two fields to every relay-auth signed body:

- `nonce`: 16 random bytes, base64url (`crypto.randomBytes(16).toString('base64url')`),
  generated per send attempt.
- `signed_at`: ISO 8601 timestamp, set per send attempt.

`signed_at` replaces the four per-message timestamp fields, which were never
semantically distinct from "when this request was signed":

| Builder | Removed field | File |
|---|---|---|
| `buildForwardRequest` | `forwarded_at` | `federation-router.mjs:53` |
| `buildRedemptionRequest` | `requested_at` | `federation-directory-client.mjs:19` |
| `buildConfirmationRequest` | `confirmed_at` | `federation-directory-client.mjs:25` |
| `buildRevocationRequest` | `revoked_at` | `federation-directory-client.mjs:30` |

The handlers that currently validate `confirmed_at` / `revoked_at` with
`isoString()` (`accept-federation-directory.mjs:184` and `:216`) read `signed_at`
instead. `acceptDirectoryRedemption` currently reads no timestamp, so it gains
nothing beyond the shared check.

This changes the canonical bytes that get signed. The cutover is hard: a peer
that does not send `nonce` and `signed_at` is rejected. Federation is pre-GA and
every relay runs this same codebase, so no transitional tolerance is built.

### verifyInboundRelayRequest

Split the function into two parts:

1. `verifyInboundRelayRequest(rawBody, headers, { getPeerByKid, now, freshnessMs })`
   keeps steps 1-3 (parse, resolve peer by kid, verify signature) and adds a
   pre-return freshness check:
   - `signed_at` present, parseable, and within `±freshnessMs` of `now`
     (`freshnessMs` defaults to `RELAY_REQUEST_FRESHNESS_MS = 5 * 60_000`,
     overridable for tests). Otherwise `RELAY_REQUEST_STALE` / 401.
   - `nonce` is a string within a length bound (for example 1 to 128 chars).
     Otherwise `INVALID_FEDERATION_REQUEST` / 400.
   - It returns the parsed `nonce` and `signed_at` alongside the existing
     `{ ok, originDomain, peerRecord, parsedBody }`. It does **not** consume the
     nonce.
2. Nonce consumption moves into the handler transaction so it rolls back with a
   failed handler:
   - **Directory path** (`http-server.mjs:212`): the first statement inside the
     existing `repository.withTransaction` callback is
     `await repository.consumeRelayNonce(verified.nonce, { now, expiresAt: signedAtMs + RELAY_REQUEST_FRESHNESS_MS, client })`.
     A `RELAY_REPLAYED` error maps to a 409 response.
   - **Envelope path** (`accept-federated-envelope.mjs:107`): the first statement
     inside the existing `repository.withTransaction` callback is the same
     `consumeRelayNonce` call on the transaction `client`. A `RELAY_REPLAYED`
     error maps to a 409 response through the existing `.catch` classifier
     (add `RELAY_REPLAYED: 409` to `statusByCode`).

Both call sites already run `verifyInboundRelayRequest` before opening the
transaction, so the signature check stays outside the transaction and only the
nonce insert is inside it.

Clock skew: `±5 minutes` symmetric tolerance assumes participating relays keep
their clocks within 5 minutes of each other, which NTP-synced hosts satisfy with
wide margin. `RELAY_REQUEST_FRESHNESS_MS` is a module constant; making it a
`relay-config.mjs` value is a follow-up if operational experience shows it is
needed.

### Reaper

No `RELAY_REPLAYED` special case. Each retry re-signs (fresh nonce, fresh
`signed_at`) so a retry of a request the peer already processed is not a replay
at the relay-auth layer. The handler's own state-idempotency absorbs the
double-apply:

- redemption of an already-redeemed invite by the same redeemer returns an
  idempotent 202,
- confirmation of an already-confirmed link returns a 202 no-op,
- revocation of an already-revoked link returns a 202 no-op,
- an envelope with an already-seen `message_id` / `idempotency_key` returns
  `202 duplicate`.

The reaper's existing outcome classifier is unchanged. The re-sign happens where
the reaper rebuilds the outbound request from the stored row; the builders
generate the fresh nonce and `signed_at` on each call, so this is automatic once
the builders take those fields.

## Section 4 — Q4: plaintext invite code

### outbox show redaction

In `cmdFederationOutbox` `show` (`sigil.mjs:829`), extend the destructured strip
set to drop `directoryPayload` from operator output, matching the `list` variant
which already omits it. Do this regardless of the at-rest decision.

### At rest — never persist the secret

Confirmation and revocation outbox bodies carry no secret; only redemption does.
The redeemer relay stops persisting the invite code.

- `buildRedemptionRequest` still puts `code` on the wire (the issuer relay needs
  it to redeem) but the CLI's `enqueueFederationForward` call for a transport
  failure is removed for `kind: 'directory_redemption'`. On a transport failure
  the CLI prints a message telling the operator to re-run
  `sigil federation invite redeem <code>`.
- Confirmation and revocation keep their `enqueueFederationForward` retry paths
  unchanged — they hold no secret.
- Migration 019 adds a guard so a `directory_redemption` row cannot carry a code:
  either drop `directory_payload` for that `kind` at insert time in the
  repository, or store the redemption row with `directory_payload` limited to
  `{ link_ref }`. The redeem path never reads `directory_payload` back for a
  redemption row after this change, so the minimal form is safe.

Re-running `sigil federation invite redeem <code>` after a transport failure
works because the issuer redemption handler is idempotent for the same redeemer:
if attempt 1 reached the issuer, the invite is `redeemed` and the handler returns
an idempotent 202 with the `issuer` block; if attempt 1 never reached the issuer,
the invite is still `pending` and the redemption proceeds normally. Either way
the CLI gets the `issuer` block and writes the redeemer-side link. This
dependency is stated in the spec so a later change to the handler's idempotency
does not silently break redemption recovery.

## Section 5 — Testing

Each blocker gets a failing test that proves the exploit before the fix lands,
per the branch's TDD mandate.

- **B1 red:** a pinned peer at domain A POSTs an envelope with
  `sender_owner_id = usr_victim@receiver` (a local owner on the receiver), a
  self-generated `sender_key`, and a valid envelope signature over it. Assert the
  current code delivers (202, message persisted). After the fix, assert
  `DIRECTORY_LINK_REQUIRED` / 403.
- **B1 green:** with an active self-pair link
  (`local_owner_id = remote_owner_id = usr_x@home`, `remote_domain = A`,
  `status = 'active'`), assert same-owner federated delivery from A succeeds. This
  test depends on migration 019 and the self-pair write path (Section 1 ordering).
- **B2 red:** a valid invite is redeemed with
  `redeemer.owner_id = usr_x@third-domain`. Assert the current code writes an
  issuer-side link with `remote_owner_id = usr_x@third-domain`. After the fix,
  assert 400 and no row.
- **E2 red:** stub the issuer 202 response with
  `issuer.owner_id = usr_x@evil-domain`. Assert the current CLI writes a
  redeemer-side link. After the fix, assert exit code 1, no row, and a
  `federation_directory.invite_redeem_rejected` audit event.
- **B3 stale:** capture a signed revocation request, advance the clock past
  `RELAY_REQUEST_FRESHNESS_MS`, resend. Assert `RELAY_REQUEST_STALE` / 401 and the
  link is not revoked.
- **B3 replay in window:** resend a captured revocation within the window with the
  same `nonce`. Assert `RELAY_REPLAYED` / 409 and the link is not revoked twice
  (the second is a no-op anyway; the point is the 409).
- **B3 rollback safety:** force the redemption handler to throw after the
  `consumeRelayNonce` insert (for example a `FEDERATION_LINK_EXISTS` collision).
  Assert the nonce row is absent after rollback, so a subsequent legitimate
  request with a fresh nonce is accepted.
- **B3 self-retry:** a `directory_confirmation` outbox row whose first send
  "succeeded" at the peer but whose response was lost is retried by the reaper
  with a fresh nonce and `signed_at`. Assert the peer returns a 202 no-op and the
  reaper settles the row as delivered.
- **Q4 outbox show:** assert `sigil federation outbox show <id>` output for a
  redemption row contains no `sigil-fed-invite:` substring.
- **Q4 at rest:** assert `federation_outbox.directory_payload` for a
  `directory_redemption` row has no `code` key.
- **Migration 019 live-DB:** `federation_relay_nonces` uniqueness rejects a
  duplicate insert; the relaxed `distinct_owners` CHECK accepts a
  `self_pair` row and still rejects an equal-owner row with
  `initiated_via <> 'self_pair'`.

Rename fallout: the four builder timestamp fields and their `isoString()`
validators change, so the Task 9 and Task 17 malformed-timestamp 400 tests for
`confirmed_at` / `revoked_at` move to `signed_at`.

## Section 6 — Files touched

- `sigil/migrations/019_federation_directory_security.sql` — new. `federation_relay_nonces`
  table and index; `federation_directory_links_distinct_owners` and
  `federation_directory_links_initiated_via_check` relaxed.
- `sigil/relay/v1/federation-relay-auth.mjs` — split into signature-verify plus
  freshness check; return `nonce` and `signed_at`; take `now` and `freshnessMs`.
- `sigil/relay/v1/accept-federated-envelope.mjs` — remove the same-owner exemption;
  consume the nonce as the first statement in the transaction; map
  `RELAY_REPLAYED` to 409.
- `sigil/relay/v1/accept-federation-directory.mjs` — pin `redeemer.owner_id`
  domain; read `signed_at`; set `initiated_via` for self-pair.
- `sigil/relay/v1/federation-directory-client.mjs` — builders emit `nonce` and
  `signed_at`; drop `requested_at` / `confirmed_at` / `revoked_at`.
- `sigil/relay/v1/federation-router.mjs` — `buildForwardRequest` emits `nonce` and
  `signed_at`; drop `forwarded_at`.
- `sigil/relay/v1/http-server.mjs` — thread `now` and the repository into the
  directory verify call; consume the nonce inside the directory transaction; map
  `RELAY_REPLAYED` to 409.
- `sigil/relay/v1/federation-reaper.mjs` — rebuild outbound directory requests
  through the builders so each retry re-signs (no classifier change).
- `sigil/relay/v1/postgres-repository.mjs` — `consumeRelayNonce`; `initiated_via`
  in `createFederationDirectoryLink` writes.
- `sigil/cli/memory-repository.mjs` — `consumeRelayNonce` equivalent (`Map`-backed).
- `sigil/cli/sigil.mjs` — E2 issuer-domain check plus rejection audit; `outbox show`
  redaction; allow equal issuer / redeemer owner in `invite create` / `redeem`;
  set `initiated_via: 'self_pair'`; drop the redemption `enqueueFederationForward`
  branch and print the re-run message instead.
- `STATUS.md` — the replay claim is now accurate; adjust wording if it names the
  mechanism.
- Test files per Section 5, plus the Task 9 / Task 17 timestamp-field test moves.

## Section 7 — Rollout

All schema changes are in migration 019, additive, on an empty pre-GA table.
The signed-body contract cutover is hard and coordinated: every relay in a
federation deploys this change together. No feature flag, no transitional
tolerance in `verifyInboundRelayRequest`.

After implementation: re-run the whole-branch review against
`b11dfc3..HEAD`, then `superpowers:finishing-a-development-branch`. Do not push
before a human-reviewed final step approves it.
