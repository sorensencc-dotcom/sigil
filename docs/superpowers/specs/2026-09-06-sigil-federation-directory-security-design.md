# Sigil cross-federation directory — security hardening design

Date: 2026-09-06
Branch: `feat/cross-federation-directory` (off `main` `b11dfc3`, HEAD `6fe8101`, not pushed)
Status: design under review (revision 2, folds in the first review pass)

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
- Memory-repository vs Postgres-repository parity gaps in the directory methods,
  beyond the nonce-store limitation this spec calls out explicitly (Section 3).
- Migration 018's `ADD CONSTRAINT` lock strategy on `federation_outbox`.
- CLI ergonomics findings (G3, G5, G6).

Migration 018 is not amended. The completed SDD tasks and the live-DB test matrix
reference it as built. All schema changes here go in a new migration 019. That
migration is **additive except for two deliberate CHECK-constraint replacements**
on `federation_directory_links` (Section 1) — the table is empty on this branch,
so the replacement carries no lock or backfill cost.

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
domain triple only — no `role` filter (verified). The envelope-receive lookup
`(recipient.owner_id, senderOwnerId, originDomain)` therefore matches a self-pair
row regardless of whether the receiving relay holds the `issuer` side
(`remote_domain` = redeemer's posting domain) or the `redeemer` side
(`remote_domain` = issuer domain). In both directions the receiver's row carries
`remote_domain` equal to the sender's relay domain, which is `originDomain` on
the receive path. No repository change is needed.

### Schema (migration 019)

Two CHECK-constraint replacements on `federation_directory_links`. Migration 018
declares `distinct_owners` with an explicit name; the `initiated_via` CHECK is
inline and unnamed, so Postgres auto-names it
`federation_directory_links_initiated_via_check` (the deterministic
`<table>_<column>_check` form). The migration verifies both names against
`information_schema.table_constraints` in a `DO` block and fails loudly if either
differs, rather than letting a silent `DROP ... IF EXISTS` no-op leave a stale
constraint in place.

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'federation_directory_links_distinct_owners') THEN
    RAISE EXCEPTION 'migration 019: expected constraint federation_directory_links_distinct_owners not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'federation_directory_links_initiated_via_check') THEN
    RAISE EXCEPTION 'migration 019: expected constraint federation_directory_links_initiated_via_check not found';
  END IF;
END $$;

ALTER TABLE federation_directory_links
  DROP CONSTRAINT federation_directory_links_initiated_via_check;
ALTER TABLE federation_directory_links
  ADD CONSTRAINT federation_directory_links_initiated_via_check
  CHECK (initiated_via IN ('invite', 'oidc_match', 'self_pair'));

ALTER TABLE federation_directory_links
  DROP CONSTRAINT federation_directory_links_distinct_owners;
ALTER TABLE federation_directory_links
  ADD CONSTRAINT federation_directory_links_distinct_owners
  CHECK (local_owner_id <> remote_owner_id OR initiated_via = 'self_pair');
```

The replacement keeps a guard against an accidental self-pair on a link that was
not deliberately created as one, and gives `initiated_via` a real writer (it was
previously dead — review finding F6). The table is empty on this branch; the
`ADD CONSTRAINT` scan cost is nil. The migration file records that fact in a
comment.

The partial unique index `federation_directory_links_live_pair_uidx` on
`(local_owner_id, remote_owner_id, remote_domain) WHERE status IN ('pending','active')`
already prevents duplicate self-pair links.

### CLI and handler

- `sigil federation invite create` and `sigil federation invite redeem` stop
  rejecting the case where the issuer owner equals the redeemer owner.
- `acceptDirectoryRedemption` and the redeemer-side link write in
  `cmdFederationInviteRedeem` set `initiated_via: 'self_pair'` when the two owner
  ids are equal, and `'invite'` otherwise.
- `createFederationDirectoryLink` (both repositories) gains an `initiatedVia`
  parameter, defaulting to `'invite'` for callers that do not pass it.

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
019.

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

Failure routes to the existing generic `400 INVALID_FEDERATION_REQUEST`
"redeemer ids are malformed or not on the posting domain". No new response code.

### E2 — shared issuer-response validator

Add an exported pure function to `federation-directory-client.mjs`:

```js
export function assertIssuerResponseIdentity(issuer, issuerDomain) {
  // Throws { code: 'ISSUER_IDENTITY_DOMAIN_MISMATCH' } unless issuer.owner_id
  // and issuer.endpoint_id are both well-formed federated ids whose domain
  // equals issuerDomain (case-insensitive).
}
```

`cmdFederationInviteRedeem` (`sigil.mjs`) calls it after
`const issuer = outcome.body?.issuer` and its truthiness check at line 1090, and
before `reserveRateLimit` / `createFederationDirectoryLink`. On a thrown
`ISSUER_IDENTITY_DOMAIN_MISMATCH`:

- write a rejected audit event (`eventType:
  'federation_directory.invite_redeem_rejected'`, `outcome: 'rejected'`, `reason:
  'ISSUER_IDENTITY_DOMAIN_MISMATCH'`, `payload: { peer_domain: issuerDomain }`),
- print a specific `console.error`,
- set `process.exitCode = 1`,
- return without reserving quota and without writing the link row.

The reaper's `directory_redemption` path — which also consumed
`outcome.body.issuer` unchecked (`federation-reaper.mjs:131-151`) — is removed
entirely by Section 4, so there is no second call site to guard. The function is
exported regardless, for test isolation and any future reuse.

## Section 3 — B3: replay defense

### Model

Every relay-to-relay request carries a `nonce` and a `signed_at`, added to the
signed body. Replay defense is:

1. **Nonce table.** `verifyInboundRelayRequest` (after the signature check) hands
   the nonce to the handler, which consumes it inside its own transaction. A
   second consume of the same nonce throws `RELAY_REPLAYED`. Consuming inside the
   transaction means a handler that rolls back does not burn the nonce, so a
   legitimate follow-up is still accepted.
2. **Freshness window.** `signed_at` must be within a configurable window of the
   verifier's clock. This bounds how long a captured request stays replayable and
   gives the nonce table a prune horizon.

Each send attempt signs a **fresh** nonce and a fresh `signed_at`. The nonce is
never reused across retries. Its only job is to reject an attacker's verbatim
resend of a single captured request. Duplicate application of a caller's own
retry is absorbed by the handlers' existing state-idempotency:

- redemption of an already-redeemed invite by the same redeemer returns an
  idempotent 202 (`accept-federation-directory.mjs:103-109`),
- confirmation of an already-confirmed link returns a 202 no-op (`:197-199`),
- revocation of an already-revoked link returns a 202 no-op (`:224-226`),
- an envelope with an already-seen `message_id` / `idempotency_key` returns
  `202 duplicate` (`accept-federated-envelope.mjs:108-112`).

Because retries carry a fresh nonce, a caller's own retry never collides with the
nonce table, so there is no "`RELAY_REPLAYED` means already delivered" reaper
rule. A `RELAY_REPLAYED` seen by the reaper is a genuine external-replay signal
and is surfaced as a `forward_rejected` terminal state like any other 4xx.

### Schema (migration 019)

Mirror `login_jti_replays` (migrations 013, 015):

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

Pruning: add `DELETE FROM federation_relay_nonces WHERE expires_at < now()` to
whichever periodic maintenance path already prunes `login_jti_replays`. If no
such path exists, this spec adds a `pruneRelayNonces(now)` method and a note that
wiring it to a scheduler is a follow-up; unbounded growth is bounded in practice
by the freshness window times request rate.

`sigil/cli/memory-repository.mjs` gets a `Map<nonce, expiresAt>`-backed
`consumeRelayNonce` that throws the same `RELAY_REPLAYED`. Its `withTransaction`
is `fn(null)` (a no-op — `memory-repository.mjs:64-67`), so nonce consumption on
a memory relay is **not** transactionally rollback-safe. The rollback-safety test
(Section 5) runs on Postgres only; the memory suite asserts replay rejection but
explicitly does not assert rollback behavior. This limitation is acceptable:
federation over a memory relay is a development and test configuration.

### Signed-body contract

Add two fields to every relay-auth signed body:

- `nonce`: exactly 16 random bytes, base64url-encoded to 22 characters with no
  padding (`crypto.randomBytes(16).toString('base64url')`). The verifier
  validates `^[A-Za-z0-9_-]{22}$` and rejects anything else with
  `INVALID_FEDERATION_REQUEST` / 400. Generated per send attempt.
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
`isoString()` (`accept-federation-directory.mjs:184`, `:216`) read `signed_at`
instead. `acceptDirectoryRedemption` currently reads no timestamp, so it gains
only the shared verifier check.

This changes the canonical bytes that get signed. The cutover is hard: a peer
that omits `nonce` or `signed_at` is rejected. Federation is pre-GA and every
relay runs this same codebase, so no transitional tolerance is built.

### verifyInboundRelayRequest

Split into two exports:

1. `verifyInboundRelayRequest(rawBody, headers, { getPeerByKid, now, freshnessMs })`
   keeps steps 1-3 (parse, resolve peer by kid, verify signature) and adds a
   pre-return check:
   - `signed_at` present, parseable, within `±freshnessMs` of `now`. Otherwise
     `RELAY_REQUEST_STALE` / 401.
   - `nonce` matches `^[A-Za-z0-9_-]{22}$`. Otherwise `INVALID_FEDERATION_REQUEST` / 400.
   - Returns `nonce` and `signedAtMs` alongside the existing
     `{ ok, originDomain, peerRecord, parsedBody }`. Does **not** consume the nonce.
2. `consumeRelayNonce` is called by each handler as the first statement inside its
   transaction, on the transaction `client`:
   - **Directory path** (`http-server.mjs:212`): first statement inside the
     existing `repository.withTransaction` callback:
     `await repository.consumeRelayNonce(verified.nonce, { now, expiresAt: verified.signedAtMs + freshnessMs, client })`.
     A `RELAY_REPLAYED` error maps to a 409 response.
   - **Envelope path** (`accept-federated-envelope.mjs:107`): first statement
     inside the existing `repository.withTransaction` callback, same call. Add
     `RELAY_REPLAYED: 409` to the `.catch` classifier's `statusByCode`.

The signature check stays outside the transaction at both call sites (both
already run `verifyInboundRelayRequest` before opening the transaction); only the
nonce insert is inside it.

### Freshness configuration

`resolveRelayConfig` / `relay-config.mjs` gains `relayRequestFreshnessMs`,
default `300_000`, clamped to `[60_000, 3_600_000]` at load with a startup log
line stating the effective value. `verifyInboundRelayRequest` takes it as
`freshnessMs`; the handlers reuse the same value for the nonce `expiresAt`.

Operational visibility: every `RELAY_REQUEST_STALE` rejection records an audit
event (`eventType: 'federation.inbound_rejected'`, `reason:
'RELAY_REQUEST_STALE'`, `payload` includes the `signed_at` skew in seconds) so an
operator can see clock-drift rejections building up before they become an outage.

### Reaper

The envelope path already rebuilds through `buildForwardRequest` from the stored
`row.envelope` and sibling columns (`federation-reaper.mjs:280`), so it picks up
a fresh `nonce` / `signed_at` on every retry with no change beyond the builder
emitting them.

The directory path currently signs `row.directoryPayload` verbatim
(`federation-reaper.mjs:163`, an invariant stated in the module header). This spec
overturns that invariant **for confirmation and revocation rows only**:

- The enqueued `directory_payload` for a `directory_confirmation` /
  `directory_revocation` row stores only `{ link_ref }`.
- `dispatchDirectoryRow` rebuilds the request on each pass:
  `buildConfirmationRequest({ linkRef: row.directoryPayload.link_ref, now })` or
  `buildRevocationRequest({ ... })`, then `signRelayRequest`. Each pass therefore
  carries a fresh `nonce` and a `signed_at` equal to the reaper's current clock —
  so a row that drains 30 minutes after enqueue is never stale.
- The "uncanonicalizable payload → dead-letter as `FORWARD_BUILD_FAILED`" guard
  moves to wrap the `build*Request` call.
- The module header comment is updated to describe the rebuild.

`directory_redemption` rows are removed from the outbox entirely (Section 4), so
`PATH_BY_KIND` loses that key, the `row.kind === 'directory_redemption'` branch
(`:210-212`) and `writeRedeemerLink` (`:125-158`) are deleted, and the
`federation_outbox_kind_check` value stays permitted only for backward tolerance
of any pre-019 row.

## Section 4 — Q4: plaintext invite code

### outbox show redaction

In `cmdFederationOutbox` `show` (`sigil.mjs:829`), extend the destructured strip
set to drop `directoryPayload` from operator output, matching the `list` variant
which already omits it. Independent of everything below.

### Redemption: no durable retry

The invite `code` is a secret and the redeemer relay has no invite row to
reconstruct it from, so a durable retry of a redemption would have to persist the
code. Rather than persist it, redemption loses its durable retry.

- `cmdFederationInviteRedeem` (`sigil.mjs:1072-1084`): the
  `enqueueFederationForward({ kind: 'directory_redemption', ... })` branch on
  `FORWARD_TRANSPORT_FAILED` is deleted. On a transport failure the CLI prints:
  `issuer relay unreachable; re-run 'sigil federation invite redeem <code>' when it is back`,
  and exits non-zero. No `federation_outbox` row is written.
- Confirmation and revocation keep their `enqueueFederationForward` retry paths.
  Their bodies hold no secret; under Section 3 their stored payload is only
  `{ link_ref }`.
- The reaper's entire `directory_redemption` path is removed (Section 3).

### Existing rows

Migration 019 scrubs any redemption row left by an earlier build and records that
in-flight redemptions do not survive the upgrade:

```sql
-- Pre-019 directory_redemption rows carry the plaintext invite code. This
-- branch is unpushed and pre-GA, so in practice this affects only local dev
-- databases. Scrub the secret; the rows themselves are left to dead-letter and
-- the operator re-runs the redeem command (see design Section 4).
UPDATE federation_outbox
   SET directory_payload = directory_payload - 'code'
 WHERE kind = 'directory_redemption'
   AND directory_payload ? 'code';
```

The migration also asserts the expected count is zero on a clean checkout and
logs (does not fail) if it finds any, so the operator sees that manual re-runs
are pending.

### Recovery semantics

A redemption interrupted by a transport failure or a process kill is recovered by
re-running `sigil federation invite redeem <code>`, and this is always safe:

- **Transport failed before the issuer received it.** Invite is still `pending`.
  Re-run redeems normally.
- **Issuer committed, response lost.** Invite is `redeemed` bound to this same
  redeemer. Re-run: the issuer returns an idempotent 202 with the `issuer` block
  (`accept-federation-directory.mjs:103-109`); the CLI then writes the
  redeemer-side link, catching `FEDERATION_LINK_EXISTS` if a prior partial run
  already wrote it (`sigil.mjs:1121-1124`).
- **Process killed between the issuer 202 and the local link write.** Same as
  above — the issuer's idempotency plus the local `FEDERATION_LINK_EXISTS` catch
  make the re-run converge.
- **Operator re-runs several times.** Each is an idempotent 202 at the issuer and
  a caught duplicate locally. No divergent state.
- **Bound.** The invite stays redeemable until its own `expires_at`; past that a
  re-run gets the generic `INVALID_FEDERATION_INVITE` and the operator mints a new
  invite.

The cost of this change is the loss of unattended retry for one operator-run
command. Confirmation and revocation, which can be triggered by automation, keep
their durable retry.

## Section 5 — Testing

Each blocker gets a failing test that proves the exploit before the fix, per the
branch's TDD mandate.

- **B1 red:** a pinned peer at domain A POSTs an envelope with
  `sender_owner_id = usr_victim@receiver` (a local owner on the receiver), a
  self-generated `sender_key`, and a valid envelope signature. Assert the current
  code delivers (202, message persisted). After the fix, assert
  `DIRECTORY_LINK_REQUIRED` / 403.
- **B1 green:** with an active self-pair link
  (`local_owner_id = remote_owner_id = usr_x@home`, `remote_domain = A`,
  `status = 'active'`, `initiated_via = 'self_pair'`), assert same-owner federated
  delivery from A succeeds. Depends on migration 019 and the self-pair write path
  (Section 1 ordering); on the memory suite the row is inserted directly.
- **B2 red:** a valid invite redeemed with
  `redeemer.owner_id = usr_x@third-domain`. Assert the current code writes an
  issuer-side link with that foreign `remote_owner_id`. After the fix, assert 400
  and no row.
- **E2 red:** call `assertIssuerResponseIdentity` with
  `issuer.owner_id = usr_x@evil-domain, issuerDomain = issuer.example`; assert it
  throws `ISSUER_IDENTITY_DOMAIN_MISMATCH`. Integration: stub the issuer 202 with
  that body, assert the CLI exits 1, writes no link row, and records
  `federation_directory.invite_redeem_rejected`.
- **B3 stale:** capture a signed revocation, advance the clock past
  `relayRequestFreshnessMs`, resend. Assert `RELAY_REQUEST_STALE` / 401, the link
  is not revoked, and an audit event with the skew is recorded.
- **B3 replay in window:** resend a captured revocation within the window,
  verbatim (same nonce). Assert `RELAY_REPLAYED` / 409.
- **B3 rollback safety (Postgres only):** force the redemption handler to throw
  after `consumeRelayNonce` (a `FEDERATION_LINK_EXISTS` collision). Assert the
  nonce row is absent after rollback and a later request with a fresh nonce is
  accepted.
- **B3 reaper re-sign:** enqueue a `directory_confirmation` row; run two reaper
  passes with a stubbed transport failure then success; assert the two outbound
  request bodies carry different `nonce` values and different `signed_at` values,
  and that the second `signed_at` is within the window of the second pass's
  clock.
- **B3 nonce format:** `nonce` of length 21, 23, or with a `+` / `/` character is
  rejected `INVALID_FEDERATION_REQUEST` / 400.
- **Q4 outbox show:** `sigil federation outbox show <id>` output for a
  confirmation row contains no `sigil-fed-invite:` substring and no
  `directoryPayload` key.
- **Q4 no redemption row:** a redemption whose POST hits `FORWARD_TRANSPORT_FAILED`
  writes no `federation_outbox` row and exits non-zero with the re-run message.
- **Q4 recovery:** after a simulated "issuer committed, response lost", a second
  `redeem` run converges (issuer idempotent 202, local link written or
  `FEDERATION_LINK_EXISTS` caught).
- **Migration 019 live-DB:** `federation_relay_nonces` uniqueness rejects a
  duplicate insert; the `DO`-block name assertions pass on an 018 schema; the
  relaxed `distinct_owners` CHECK accepts a `self_pair` row and rejects an
  equal-owner row with `initiated_via <> 'self_pair'`; the scrub `UPDATE` removes
  `code` from a seeded pre-019 redemption row.

Rename fallout: the four builder timestamp fields and their `isoString()`
validators change, so the Task 9 and Task 17 malformed-timestamp 400 tests for
`confirmed_at` / `revoked_at` move to `signed_at`.

## Section 6 — Files touched

- `sigil/migrations/019_federation_directory_security.sql` — new.
  `federation_relay_nonces`; the two `federation_directory_links` CHECK
  replacements behind name assertions; the pre-019 redemption-row scrub.
- `sigil/relay/v1/federation-relay-auth.mjs` — signature-verify plus freshness
  check; return `nonce` and `signedAtMs`; take `now` and `freshnessMs`.
- `sigil/relay/v1/accept-federated-envelope.mjs` — remove the same-owner
  exemption; consume the nonce as the first statement in the transaction; map
  `RELAY_REPLAYED` to 409.
- `sigil/relay/v1/accept-federation-directory.mjs` — pin `redeemer.owner_id`
  domain; read `signed_at`; set `initiated_via` for self-pair.
- `sigil/relay/v1/federation-directory-client.mjs` — builders emit `nonce` and
  `signed_at`, drop `requested_at` / `confirmed_at` / `revoked_at`; new
  `assertIssuerResponseIdentity`.
- `sigil/relay/v1/federation-router.mjs` — `buildForwardRequest` emits `nonce` and
  `signed_at`, drops `forwarded_at`.
- `sigil/relay/v1/federation-reaper.mjs` — rebuild `directory_confirmation` /
  `directory_revocation` rows through the builders each pass; delete the
  `directory_redemption` path and `writeRedeemerLink`; update the header comment.
- `sigil/relay/v1/http-server.mjs` — thread `now` and `freshnessMs` into the
  directory verify call; consume the nonce inside the directory transaction; map
  `RELAY_REPLAYED` to 409.
- `sigil/relay/v1/relay-config.mjs` — `relayRequestFreshnessMs` with clamp and
  startup log.
- `sigil/relay/v1/postgres-repository.mjs` — `consumeRelayNonce`,
  `pruneRelayNonces`; `initiatedVia` in `createFederationDirectoryLink`.
- `sigil/cli/memory-repository.mjs` — `Map`-backed `consumeRelayNonce`;
  `initiatedVia` in `createFederationDirectoryLink`.
- `sigil/cli/sigil.mjs` — `assertIssuerResponseIdentity` call plus rejection
  audit; `outbox show` redaction; allow equal issuer / redeemer owner in `invite
  create` / `redeem`; set `initiated_via: 'self_pair'`; delete the redemption
  `enqueueFederationForward` branch and print the re-run message.
- `STATUS.md` — the replay claim is now accurate; adjust wording if it names the
  mechanism.
- Test files per Section 5, plus the Task 9 / Task 17 timestamp-field test moves.

## Section 7 — Rollout preconditions

Verify before implementing, and again before the re-review:

- **`federation_directory_links` is empty** on every target database:
  `SELECT count(*) FROM federation_directory_links` returns 0. If not, the
  migration-019 CHECK replacement needs a per-row audit first.
- **No pre-019 `directory_redemption` outbox rows** outside local dev:
  `SELECT count(*) FROM federation_outbox WHERE kind = 'directory_redemption'`.
  Any hit means an operator must re-run those redemptions after the upgrade.
- **Constraint names match** what Section 1 assumes: `\d federation_directory_links`
  shows `federation_directory_links_distinct_owners` and
  `federation_directory_links_initiated_via_check`. The migration's `DO` block
  enforces this, but check it by hand once before writing the plan.
- **Handler idempotency holds** as Section 3 relies on: the existing tests
  `accept-federation-directory.test.mjs` "idempotent replay" (redemption),
  "already confirmed → noop", "already revoked → noop", and
  `accept-federated-envelope.test.mjs` "duplicate idempotency_key → 202" all
  pass on HEAD before this work starts.
- **Relay clocks** on the federation fleet are NTP-synced and observed within a
  few seconds of each other; `relayRequestFreshnessMs` default 300 s leaves wide
  margin. Record the observed skew in the re-review notes.

## Section 8 — After implementation

Re-run the whole-branch review against `b11dfc3..HEAD`, then
`superpowers:finishing-a-development-branch`. Do not push before a human-reviewed
final step approves it.
