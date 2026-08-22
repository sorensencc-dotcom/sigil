# Sigil Endpoint Directory & Trust Spec v1.0

**Status:** Draft — not yet reviewed
**Scope:** First-contact trust between two humans' endpoints on a shared relay
**Depends on:** `sigil-protocol-spec-v1.0.0-draft.md`, `sigil-human-approval-auth-spec-v1.0.md`,
`sigil-plugin-connector-auth-spec-v1.0.md` (§5 human identity/OIDC model),
`sigil-v1-conformance-gap-closure-design.md` (§3/§6/§7/§8 accept-transaction pattern)

## 1. Problem

Every existing spec assumes the sender and recipient endpoint already know
and trust each other: `init` registers whatever a human puts in a local
registry file, and the relay authorizes delivery based on capability grants
and rate/depth limits — never on whether the recipient *wants* mail from
that sender. There is no first-contact flow: no way for two humans who have
never interacted to establish that an `endpoint_id` claim is real, and no
relay-side gate that stops an already-registered endpoint from messaging
any other registered endpoint on the same relay. This spec closes that gap
for a single shared relay. Cross-relay federation (Sigil-to-Sigil, not just
human-to-human) is explicitly out of scope for v1 — see §7.

## 2. Non-goals

- Cross-relay federation. One relay, many humans/endpoints, is the unit
  this spec covers. §7 defines the minimum groundwork so a later version
  doesn't require renaming primary keys, not the federation protocol
  itself.
- Replacing or duplicating capability grants. A capability grant answers
  "is this endpoint allowed to invoke this action"; a directory link
  answers "is this endpoint allowed to reach this endpoint at all." They
  are checked together but stay separate tables with separate revocation
  lifecycles (see §4 rationale).
- A UI. This spec defines relay behavior and data model; CLI/connector UX
  for redeeming invites or reviewing pending links is implementation
  detail against the interfaces defined here.

## 3. Trust on-ramps

A directory link may be established two ways. Both terminate in the same
`pending` row (§4); nothing is trusted until both humans confirm (§5).

### 3.1 Invite code

The lower-friction path, and the one that needs no identity provider.

1. Human A (owner of endpoint A) requests an invite from their connector.
   The relay generates a high-entropy, single-use code, stores its hash
   (never the code itself) bound to `(issuer_endpoint_id, issuer_human_id)`
   with a short expiry (default 24h, configurable per deployment), and
   returns the plaintext code to A's connector once.
2. A shares the code with B out-of-band (chat, email, in person, QR — the
   relay does not care how).
3. B's connector submits the code plus B's authenticated endpoint/human
   context to a redemption endpoint. The relay verifies the code's hash,
   status, and expiry, then creates a `directory_links` row in `pending`
   status naming both endpoints and both humans, and marks the invite
   `redeemed`.
4. A redeemed, expired, or unknown code fails closed with one generic
   error — the relay does not distinguish "wrong code" from "expired
   code" in the response, to avoid turning the redemption endpoint into a
   code-guessing oracle beyond what rate limiting already prevents.

### 3.2 OIDC match

For deployments that already run human OIDC authentication (§5.1 of the
connector-auth spec) and want to add someone by an identity they already
know, not a code they have to receive out-of-band.

1. Human A specifies a target: an allow-listed issuer (§3.3) plus a claim
   to match — a `provider_verified` email attribute, per the existing
   rule that email is a claim, never a subject-identity substitute
   (connector-auth spec §5.3). A never sees or specifies a raw `subject`;
   the relay resolves the match against verified attribute rows.
2. The relay creates a `directory_links` row in `pending` status with
   `human_b` unresolved and a hashed match target (matched against
   `human_attributes` where `verification_state = 'provider_verified'`).
3. When any human authenticates via that issuer and their verified claim
   matches, the pending row resolves `human_b` to that authenticated
   human's `human_id` and (once B nominates or confirms an endpoint —
   OIDC identifies a human, not an endpoint) proceeds to §5 confirmation.
4. Non-match fails closed with the same generic error as §3.1.4 — the
   requester never learns whether a given email exists on this relay,
   only whether their invite/match attempt is still `pending`.

### 3.3 OIDC issuer allow-list

Formalizes the connector-auth spec's already-locked policy ("deployments
MUST provide an explicit non-empty OIDC issuer allow-list," §10) as a
concrete table rather than deployment-config prose:

```text
oidc_issuer_allowlist(issuer PK, display_label, discovery_url, enabled,
                       assurance_level, added_by, added_at)
```

`assurance_level` is fixed at `standard` for every OIDC issuer per the
already-locked rule (OIDC sessions = standard, WebAuthn = high); this
table does not reopen that decision, it only lets an operator enable
specific issuers. A deployment's default seed lists no rows — Tier 1 must
explicitly enable each issuer, consistent with "Tier 1 still must approve
provider membership" (connector-auth spec §10). Google, GitHub, and X are
expected common entries once approved; nothing about this table is
provider-specific, so enabling any standards-compliant OIDC issuer is the
same operation. No client secret or credential material lives in this
table — that stays in deployment environment configuration, matching the
connector-auth spec's existing separation of provider secrets from
relay-persisted state.

## 4. Data model

```text
directory_invites(
  invite_id PK, issuer_endpoint_id FK->endpoints, issuer_human_id FK->humans,
  code_hash, status CHECK IN (pending, redeemed, expired, revoked),
  expires_at, redeemed_by_human_id FK->humans NULLABLE,
  redeemed_at NULLABLE, home_relay, created_at
)

directory_links(
  link_id PK,
  endpoint_a FK->endpoints, endpoint_b FK->endpoints,
  human_a FK->humans, human_b FK->humans NULLABLE,
  status CHECK IN (pending, active, revoked),
  initiated_via CHECK IN (invite, oidc_match),
  a_confirmed_at NULLABLE, b_confirmed_at NULLABLE,
  revoked_at NULLABLE, revoked_by FK->humans NULLABLE,
  home_relay, created_at,
  UNIQUE (endpoint_a, endpoint_b)
)

oidc_issuer_allowlist(
  issuer PK, display_label, discovery_url, enabled,
  assurance_level CHECK (assurance_level = 'standard'),
  added_by, added_at
)
```

`directory_links` rows are stored with `endpoint_a < endpoint_b` (a fixed
lexical ordering) so the unique constraint catches both link directions
without a second row; the accept-transaction check (§6) queries with
`ORDER BY`-independent lookup, not sender/recipient order.

`human_b` is nullable because OIDC-match (§3.2) creates the row before the
target human is known; invite redemption (§3.1) always populates both
humans at creation. A row with `human_b` still null after its parent
match-target expiry (same default as invite expiry, §3.1) is expired the
same way an unredeemed invite is.

`directory_links` is deliberately not the same table as `capability_grants`
(migration `006_capability_registry.sql`): a capability grant is
per-action, single-actor authorization ("this endpoint may invoke
`sigil.task/submit`"); a directory link is symmetric, human-approved
contact authorization ("these two endpoints may exchange envelopes at
all"). Collapsing them would force every directory relationship through
capability semantics (one-sided grant, no natural "both sides confirmed"
state) and would tie contact revocation to capability revocation, which
have different owners and different audit questions in practice — "can B
still message me" is a different question from "can B still ask me to run
`sigil.task/process`."

## 5. Confirmation and revocation

A `pending` link becomes `active` only when both `a_confirmed_at` and
`b_confirmed_at` are set — invite redemption (§3.1.3) sets the redeemer's
confirmation immediately (redeeming a code someone gave you *is* consent
to be findable by them) but still requires the issuer's separate
confirmation before the link activates, so a code shared into the wrong
hands doesn't silently open contact without the issuer seeing who
redeemed it. OIDC-match requires both confirmations explicitly, since
neither side took an action equivalent to "I received and used a code
meant for me."

Either human may revoke an `active` or `pending` link unilaterally at any
time; revocation is immediate (no confirmation needed from the other
side, symmetric with account-link unlinking in the connector-auth spec
§5.2 requiring only the acting side's step-up auth, not the other
identity's consent). A revoked link is terminal — re-establishing contact
requires a new invite or OIDC-match, not un-revoking the old row, so the
audit trail of "this link existed, then was cut" is never overwritten.

## 6. Enforcement

The envelope-accept transaction (gap-closure design §3, the single-client
`withTransaction` pattern already used for capability/replay/quota/depth
checks) adds one more check before insert: an active `directory_links` row
must exist between `sender_endpoint_id` and `recipient_endpoint_id`, or
the envelope is rejected the same way a missing capability grant is
rejected today — fail-closed, audited via the existing rejection-audit
path (gap-closure design §9), with a distinct reason code
(`DIRECTORY_LINK_REQUIRED`) so rejection audits distinguish "not
authorized to do this" from "not authorized to contact this endpoint at
all."

`broadcast_message`-capability envelopes (existing `sigil.core/*` scope
model) are unaffected by this check when their target is a
`conversation_id` a recipient already belongs to via `conversation_members`
— directory links gate direct endpoint-to-endpoint contact, not
already-established conversation membership. A human being addable to a
conversation still requires an active directory link with whoever added
them; that ordering (link before conversation add) is enforced by the
existing `conversation_members.added_by` FK requiring an authenticated
human, combined with this section's delivery-time check on any resulting
envelope.

## 7. Federation groundwork (not implemented in v1)

Every new table in §4 carries a `home_relay` column, `NOT NULL DEFAULT`-ed
to the deployment's own configured relay origin at insert time. Nothing
reads or branches on this column in v1 — every row's `home_relay` is the
same value for a single-relay deployment. Its purpose is exclusively to
avoid a breaking migration later: a future federation version can add
cross-relay routing by making `home_relay` meaningful (a link where
`endpoint_a` and `endpoint_b` have different `home_relay` values implies
relay-to-relay delivery, not local delivery) without renaming or
re-keying any row created under this spec. No relay-to-relay discovery,
routing, or trust-chain protocol is designed here — that is deliberately
deferred to its own spec once a second relay deployment actually exists
to design against.

## 8. Required tests

- invite code: valid single redemption succeeds; second redemption of the
  same code fails; expired code fails; revoked code fails; all three
  failure cases return the same generic error;
- invite redemption sets redeemer confirmation but link stays `pending`
  until issuer also confirms;
- OIDC match: `provider_verified` match resolves `human_b` and reaches
  `pending`; `unverified` or `stale` attribute state never matches;
  non-match returns the same generic error as an invalid invite code;
  disabled or non-allow-listed issuer is rejected before any match
  attempt;
- link activation requires both confirmations regardless of on-ramp;
- unilateral revocation by either human immediately moves an `active` or
  `pending` link to `revoked`, and a revoked link cannot be un-revoked;
- envelope accept: delivery between endpoints with no `directory_links`
  row is rejected `DIRECTORY_LINK_REQUIRED`; delivery with a `pending`
  (not yet `active`) link is rejected the same way; delivery with an
  `active` link succeeds; delivery after revocation (link previously
  active) is rejected on the next envelope, not retroactively affecting
  already-delivered envelopes;
- conversation-scoped `broadcast_message` delivery is unaffected by a
  missing direct directory link between broadcaster and an existing
  conversation member;
- `directory_links` unique constraint prevents duplicate rows for the
  same endpoint pair regardless of which endpoint initiates a second
  invite/match attempt against an existing `active` link (the attempt is
  rejected, not silently merged);
- migration behavior verified against both `postgres-repository` and
  `memory-repository.mjs` per the gap-closure design's dual-repository
  testing requirement (§12).

## 9. Open items

- Invite/match rate limiting: this spec assumes the existing per-endpoint
  rate-limit scopes (gap-closure design §8) cover invite generation and
  redemption attempts, but does not define separate limits. Needs a
  decision before implementation: reuse existing scopes as-is, or add a
  dedicated `directory_invite` rate-limit scope given the code-guessing
  concern in §3.1.4.
- Invite/match default expiry (24h) is a placeholder matching the
  human-approval spec's unrelated 5-minute WebAuthn challenge window in
  spirit (short-lived, single-use) but not in duration — needs Tier 1
  approval, not just this spec's default.
- What happens to `conversation_members` rows and undelivered envelopes
  when a directory link is revoked mid-conversation is not specified
  here; §6 only defines the delivery-time gate going forward.
