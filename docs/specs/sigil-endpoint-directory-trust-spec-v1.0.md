# Sigil Endpoint Directory & Trust Spec v1.0

**Status:** Draft — round 2, addressing round 1 review (2026-08-21)
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
human-to-human) is explicitly out of scope for v1 — see §9.

## 2. Non-goals

- Cross-relay federation. One relay, many humans/endpoints, is the unit
  this spec covers. §9 defines the minimum groundwork so a later version
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
- Removing conversation membership or retracting delivered mail on
  revocation. §8 enforcement is forward-only by design.

## 3. Trust on-ramps

A directory link may be established two ways. Neither on-ramp writes a
`directory_links` row directly — both first produce a request record that
resolves into a link only once both endpoints of the eventual link are
known and both humans have confirmed (§5). This split exists because the
two on-ramps discover their second party at different points: invite
redemption learns both endpoint and human atomically; OIDC match learns
only a human, and only later — possibly never, if B declines — nominates
an endpoint.

### 3.1 Invite code

The lower-friction path, and the one that needs no identity provider.

1. Human A (owner of endpoint A) requests an invite from their connector.
   The relay generates a high-entropy, single-use code, stores its hash
   (never the code itself) bound to `(issuer_endpoint_id, issuer_human_id)`
   with an expiry per §7, and returns the plaintext code to A's connector
   once.
2. A shares the code with B out-of-band (chat, email, in person, QR — the
   relay does not care how).
3. B's connector submits the code plus B's authenticated endpoint/human
   session to a redemption endpoint. The relay verifies: the code's hash,
   status, and expiry; **and** that the submitting endpoint's
   `owner_id` equals the authenticated human session's `human_id`
   (existing `endpoints.owner_id` FK, checked explicitly here rather than
   assumed — B cannot redeem naming an endpoint they don't own). On
   success the relay creates a `directory_links` row directly in
   `pending` status naming both endpoints and both humans (invite
   redemption always has both parties, so no intermediate request table
   is needed here — see §3.2 for why OIDC match differs), sets
   `b_confirmed_at` (§5), and marks the invite `redeemed`.
4. A redeemed, expired, or unknown code fails closed with one generic
   error — the relay does not distinguish "wrong code" from "expired
   code" in the response, to avoid turning the redemption endpoint into a
   code-guessing oracle beyond what §6 rate limiting already bounds.

### 3.2 OIDC match

For deployments that already run human OIDC authentication (§5.1 of the
connector-auth spec) and want to add someone by an identity they already
know, not a code they have to receive out-of-band.

Because OIDC identifies a human, not an endpoint, and the target human
hasn't acted yet, this on-ramp cannot populate a `directory_links` row
(which requires both `endpoint_a` and `endpoint_b`) at creation time.
Instead it creates a `directory_match_requests` row — a separate table,
not a nullable-`endpoint_b` `directory_links` row — so `directory_links`
never has to represent a state where one side of the link doesn't exist
yet:

1. Human A specifies a target: an allow-listed issuer (§3.3) plus a claim
   to match — a `provider_verified` email attribute, per the existing
   rule that email is a claim, never a subject-identity substitute
   (connector-auth spec §5.3). A never sees or specifies a raw `subject`;
   the relay resolves the match against verified attribute rows. The
   relay creates a `directory_match_requests` row in `pending` status
   with a hashed match target and A's endpoint/human.
2. When any human authenticates via that issuer, the relay checks their
   verified attributes against every `pending`, unexpired match request
   for that issuer inside one transaction that claims the request with
   `UPDATE ... WHERE status = 'pending'` (the same single-client,
   row-locking pattern as the capability-grant check in the gap-closure
   design §3) — the first authenticated match to reach this transaction
   wins; the request moves to `matched` and records the matched
   `human_id`. A second authentication event matching the same
   already-`matched` request finds no `pending` row and falls through to
   the same generic non-match failure as step 4, so at most one human is
   ever bound to a given match request, with no separate "winner
   selection" step to design.
3. B (the matched human) is prompted by their connector to nominate an
   endpoint to receive the link. On nomination, the relay verifies that
   endpoint's `owner_id` equals B's `human_id` (same ownership check as
   §3.1.3), creates the `directory_links` row naming both endpoints and
   both humans, sets `b_confirmed_at`, and marks the match request
   `consumed`.
4. Non-match, expired, or already-consumed match attempts fail closed
   with the same generic error as §3.1.4 — the requester never learns
   whether a given email exists on this relay, only whether their
   invite/match attempt is still `pending`.

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
  redeemed_at NULLABLE, home_relay NOT NULL, created_at
)

directory_match_requests(
  request_id PK,
  issuer_endpoint_id FK->endpoints, issuer_human_id FK->humans,
  issuer TEXT REFERENCES oidc_issuer_allowlist(issuer),
  match_target_hash,
  status CHECK IN (pending, matched, consumed, expired, revoked),
  matched_human_id FK->humans NULLABLE,
  matched_at NULLABLE, consumed_at NULLABLE,
  expires_at, home_relay NOT NULL, created_at
)

directory_links(
  link_id PK,
  endpoint_a FK->endpoints, endpoint_b FK->endpoints,
  human_a FK->humans, human_b FK->humans,
  status CHECK IN (pending, active, revoked, expired),
  initiated_via CHECK IN (invite, oidc_match),
  source_invite_id FK->directory_invites NULLABLE,
  source_request_id FK->directory_match_requests NULLABLE,
  a_confirmed_at NULLABLE, b_confirmed_at NULLABLE,
  a_confirmed_by FK->humans NULLABLE, b_confirmed_by FK->humans NULLABLE,
  revoked_at NULLABLE, revoked_by FK->humans NULLABLE,
  home_relay NOT NULL, created_at,
  CHECK (endpoint_a <> endpoint_b),
  CHECK (human_a <> human_b),
  UNIQUE (endpoint_a, endpoint_b) WHERE status IN ('pending', 'active')
)

oidc_issuer_allowlist(
  issuer PK, display_label, discovery_url, enabled,
  assurance_level CHECK (assurance_level = 'standard'),
  added_by, added_at
)
```

`directory_links.human_a`/`human_b` are non-nullable: as of §3, a
`directory_links` row is created only once both endpoints and both humans
are known (invite redemption resolves both atomically; OIDC match resolves
the human via `directory_match_requests`, then the row is created only at
endpoint nomination, §3.2.3). No `directory_links` row ever represents a
half-known link.

Self-links are rejected outright (`endpoint_a <> endpoint_b` is always
true given distinct primary keys, but the explicit `CHECK` documents
intent). Links between two endpoints owned by the same human are rejected
in v1 via `CHECK (human_a <> human_b)`: a `directory_links` row exists to
record trust *between* humans, and same-owner endpoints don't need one to
talk to each other — the accept-envelope gate exempts same-owner pairs
directly, resolving both sender and recipient owner from the trusted
registry (never from unverified envelope fields) so the exemption can't
be reached via a forged owner id. The constraint stays additive to relax
later if a use case for an actual same-owner `directory_links` row shows up.

`directory_links` rows are stored with `endpoint_a < endpoint_b` (a fixed
lexical ordering) so the unique index catches both link directions
without a second row; the accept-transaction check (§8) queries with
`ORDER BY`-independent lookup, not sender/recipient order. The unique
index is **partial** (`WHERE status IN ('pending', 'active')`): it blocks
a second concurrent attempt at contact between the same pair, but does
not block a *new* link after a prior one reached `revoked` or `expired`
— those terminal rows stay in the table for audit history (§5) without
occupying the uniqueness slot. A new invite/match attempt against a pair
with an existing `pending` link fails with a specific "link already
pending" error (not the generic redemption-failure error — the acting
party is already authenticated and a party to the attempt, so there is no
enumeration concern here, unlike §3.1.4/§3.2.4); against an existing
`active` link, the same specific-error treatment applies, since "you're
already linked" is not sensitive information to the two already-linked
parties.

`home_relay` on every table is application-supplied at insert time from
the deployment's configured relay origin, and is a plain `NOT NULL`
column, not a SQL `DEFAULT` — the value is deployment configuration
(read once at relay startup and threaded through the repository layer),
not something the database can supply on its own, matching how existing
tables in this codebase take all values from explicit `INSERT` columns
rather than column defaults.

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
`b_confirmed_at` are set. Confirmation is actor-bound, not
endpoint-bound: setting `a_confirmed_at` requires an authenticated
**human session** (connector-auth spec §5.4 — a human session, not mere
possession of an endpoint's Ed25519 key) whose `human_id` equals
`human_a`; setting `b_confirmed_at` requires the same for `human_b`.
Endpoint-key authentication alone is never sufficient to confirm a side,
so an endpoint's key compromise cannot manufacture the human's consent
this section requires, consistent with the human-approval spec's
authority distinction between endpoint signatures and human approval.

Invite redemption (§3.1.3) sets the redeemer's confirmation (`b_confirmed_at`
/ `b_confirmed_by`) immediately as part of redemption — redeeming a code
someone gave you *is* consent to be findable by them — but still requires
the issuer's separate confirmation (`a_confirmed_at`) before the link
activates, so a code shared into the wrong hands doesn't silently open
contact without the issuer seeing who redeemed it. OIDC match sets
`b_confirmed_at` at endpoint nomination (§3.2.3) on the same reasoning;
`a_confirmed_at` still requires A's explicit confirmation.

Either human may revoke an `active` or `pending` link unilaterally at any
time; revocation is immediate (no confirmation needed from the other
side, symmetric with account-link unlinking in the connector-auth spec
§5.2 requiring only the acting side's step-up auth, not the other
identity's consent). A revoked link is terminal — re-establishing contact
requires a new invite or OIDC-match, not un-revoking the old row, so the
audit trail of "this link existed, then was cut" is never overwritten.

## 6. Rate limiting

Invite/match creation and redemption are a distinct abuse surface from
ordinary envelope delivery — redemption in particular is reachable with
only a code, not a signed endpoint identity, and §3.1.4/§3.2.4's generic
failure response is the primary defense against turning it into a
guessing oracle. Rate limiting is the second, load-bearing layer of that
defense, so this spec adds dedicated scopes rather than relying on the
existing per-endpoint envelope rate limits (gap-closure design §8):

- `directory_invite_create` — scoped per issuing endpoint and human.
- `directory_invite_redeem` — scoped per redeeming endpoint and human,
  plus IP-based throttling at the deployment's edge where available
  (defense in depth; not a relay-level requirement since not every
  deployment terminates TLS at a layer that exposes client IP to the
  relay process).
- `directory_match_create` — scoped per issuing endpoint and human.
- `directory_match_attempt` — scoped per pending match request *and* per
  requesting human, so one popular match target can't be used to exhaust
  a single global counter and lock out legitimate attempts against other
  targets.

Rejected attempts consume quota when the rejection reason is
invalid/expired/revoked/unknown code or non-match (i.e., anything an
attacker chooses by guessing) — otherwise the rate limit doesn't bound
guessing at all. Rejected attempts do **not** consume quota when the
failure is an infrastructure error (relay-side failure unrelated to the
submitted code/claim), since that would let a transient outage burn a
legitimate user's attempt budget.

## 7. Expiry

Both `directory_invites` and `directory_match_requests` expire. Default
expiry is 24 hours; deployments may configure a shorter or longer value,
bounded by a hard maximum of 7 days — long enough to cover realistic
out-of-band handoff delay (e.g. sharing a code over email with someone in
a different timezone), short enough that an unredeemed invite doesn't
become a standing, forgotten attack surface. Expiry is evaluated against
the relay's own clock at the moment of redemption/match/confirmation, not
pre-computed and cached — an invite is expired if `now() > expires_at`
when someone attempts to use it, full stop.

Expired rows transition lazily and atomically: there is no background
sweep required for correctness (though a deployment may run one for
table hygiene), because every read path that checks `status = 'pending'`
also checks `expires_at > now()` in the same transaction, and any
transition from `pending` to `expired` happens as part of that same
attempt's transaction, not a separate write. An expired invite or match
request cannot be redeemed, matched, or revived — the only way forward is
a new invite/match attempt via §3.

`directory_links.status` includes `expired` (added in §4, not present in
round 1) specifically for the case §3.2 flags: a `directory_match_requests`
row whose target never authenticates before `expires_at`. That request
transitions to `expired` directly — it never becomes a `directory_links`
row at all, since (per §4) a `directory_links` row is never created
before both endpoints are known. The `expired` status on `directory_links`
itself is reserved for a future case (e.g., a bounded confirmation window
after both endpoints are known but before both humans confirm) that this
version does not populate; §4's schema includes it now so a later version
adding such a window is an application-logic change, not a migration.

## 8. Enforcement

The envelope-accept transaction (gap-closure design §3, the single-client
`withTransaction` pattern already used for capability/replay/quota/depth
checks) adds one more check before insert: an active `directory_links` row
must exist between `sender_endpoint_id` and `recipient_endpoint_id`, or
the envelope is rejected the same way a missing capability grant is
rejected today — fail-closed, audited via the existing rejection-audit
path (gap-closure design §9), with a distinct reason code
(`DIRECTORY_LINK_REQUIRED`, added to the relay's error contract and
rejection-audit reason enum alongside the existing capability/quota
reason codes) so rejection audits distinguish "not authorized to do
this" from "not authorized to contact this endpoint at all."

Enforcement is **forward-only**, matching the non-goal in §2:

- Envelopes already accepted and delivered before a link's revocation
  remain valid; revocation never retroactively invalidates delivered
  mail.
- Envelopes queued (accepted, not yet delivered) at the moment of
  revocation are rejected at their next delivery attempt, not delivered
  under a since-revoked link.
- New direct envelopes submitted after revocation are rejected
  `DIRECTORY_LINK_REQUIRED` at accept time, per this section's check.
- `conversation_members` rows are **not** automatically removed when a
  directory link between two members is revoked. Revocation is a
  contact-level decision between two humans; it does not retroactively
  evict a participant from a conversation another human added them to.

Conversation-scoped `broadcast_message` delivery has one rule, replacing
round 1's broader (and, per review, contradictory) exception: broadcast
delivery to a recipient requires that recipient to already be an
**active member** of the target `conversation_id` in `conversation_members`
— it does **not** require, and does **not** check, a direct
`directory_links` row between broadcaster and that recipient, and it
never implicitly creates a `conversation_members` row. Directory trust is
checked exactly once in this flow: when a human is *added* to a
conversation, `conversation_members.added_by` (an authenticated human)
must have an active `directory_links` row with the human being added,
checked at add-time, in the same style of accept-transaction check as
direct delivery. Once added, membership itself — not a live directory
link — is what subsequent broadcast delivery checks, and revocation (per
the forward-only rule above) never removes that membership.

## 9. Federation groundwork (not implemented in v1)

Every new table in §4 carries a `home_relay` column (§4: application-
supplied, not a SQL default). Nothing reads or branches on this column in
v1 — every row's `home_relay` is the same value for a single-relay
deployment. Its purpose is exclusively to avoid a breaking migration
later: a future federation version can add cross-relay routing by making
`home_relay` meaningful (a link where `endpoint_a` and `endpoint_b` have
different `home_relay` values implies relay-to-relay delivery, not local
delivery) without renaming or re-keying any row created under this spec.
No relay-to-relay discovery, routing, or trust-chain protocol is designed
here — that is deliberately deferred to its own spec once a second relay
deployment actually exists to design against.

## 10. Audit events

Every state transition defined above is an auditable event, following the
existing rejection-audit pattern (gap-closure design §9) of never
blocking the primary response on audit-write success:

- `directory_invite.created`, `.redeemed`, `.expired`, `.revoked`
- `directory_match_request.created`, `.matched`, `.consumed`, `.expired`,
  `.revoked`
- `directory_link.created` (fires once, at whichever of §3.1.3/§3.2.3
  actually creates the row), `.confirmed` (fires per side, records which
  side and `confirmed_by`), `.activated` (fires once, when the second
  confirmation lands), `.revoked` (records `revoked_by`)
- `envelope.rejected` with `reason = DIRECTORY_LINK_REQUIRED` (reuses the
  existing rejection-audit event shape, gap-closure design §9, with the
  new reason code)

Every event records the acting `human_id` (or `system` for lazy expiry
transitions, which have no human actor), the affected row's primary key,
and a timestamp, matching the actor/reason/timestamp shape already
required of rejection audits.

## 11. Required tests

- invite code: valid single redemption succeeds; second redemption of the
  same code fails; expired code fails; revoked code fails; all three
  failure cases return the same generic error; redemption by an endpoint
  not owned by the authenticated human fails ownership validation before
  any code check succeeds;
- invite redemption sets redeemer confirmation but link stays `pending`
  until issuer also confirms;
- OIDC match: `provider_verified` match resolves the request to `matched`
  and reaches `pending` only after endpoint nomination; `unverified` or
  `stale` attribute state never matches; non-match returns the same
  generic error as an invalid invite code; disabled or non-allow-listed
  issuer is rejected before any match attempt; endpoint nomination by a
  human other than the matched human fails ownership validation;
- OIDC match concurrency: two simultaneous authentication events against
  the same `pending` match request — exactly one transitions it to
  `matched`, the other observes no `pending` row and receives the
  generic non-match failure, with no interleaving that lets both claim
  the match;
- link activation requires both confirmations regardless of on-ramp;
  confirmation submitted by a human session whose `human_id` doesn't
  match the side being confirmed is rejected, including when that human
  legitimately controls one of the two linked endpoints' keys but not
  the human side being confirmed;
- unilateral revocation by either human immediately moves an `active` or
  `pending` link to `revoked`, and a revoked link cannot be un-revoked;
- expiry: an invite/match request past `expires_at` cannot be redeemed,
  matched, or revived regardless of prior status; the lazy transition to
  `expired` happens within the same transaction as the failed attempt,
  not as a separate write; a deployment-configured expiry outside
  [1 hour, 7 days] is rejected at configuration time (bounds per §7);
- envelope accept: delivery between endpoints with no `directory_links`
  row is rejected `DIRECTORY_LINK_REQUIRED`; delivery with a `pending`
  (not yet `active`) link is rejected the same way; delivery with an
  `active` link succeeds; delivery after revocation (link previously
  active) is rejected on the next envelope, not retroactively affecting
  already-delivered envelopes; an envelope already queued before
  revocation is rejected at its next delivery attempt, not delivered;
- conversation membership: adding a human to a conversation requires an
  active directory link between adder and addee, checked at add-time;
  revoking that link after the add does not remove the resulting
  `conversation_members` row; subsequent broadcast delivery to that
  member succeeds based on membership alone, with no live directory-link
  check;
- `directory_links` partial unique index: a second invite/match attempt
  against a pair with an existing `pending` or `active` link is rejected
  with a specific (non-generic) conflict error, not silently merged; a
  new attempt against a pair whose only prior link is `revoked` or
  `expired` succeeds and creates a new row, coexisting with the terminal
  one;
- self-link and same-human-endpoint attempts are rejected by the `CHECK`
  constraints in §4;
- migration behavior verified against both `postgres-repository` and
  `memory-repository.mjs` per the gap-closure design's dual-repository
  testing requirement (§12).

## 12. Tier 1 decisions

Round 1 review resolved these with concrete recommendations; this
version adopts them as the spec's defaults, still pending formal Tier 1
sign-off before implementation (consistent with how the connector-auth
spec (§10) and gap-closure design (§13) both ship locked defaults that
still require Tier 1 approval, rather than leaving the value undecided):

| Item | Default adopted here | Why |
|---|---|---|
| Rate limits (§6) | Dedicated `directory_invite_create` / `directory_invite_redeem` / `directory_match_create` / `directory_match_attempt` scopes; rejected guess-driven attempts consume quota, infra failures don't | Redemption is reachable by code alone; the generic error (§3.1.4) only works if guessing is also rate-bounded |
| Expiry (§7) | 24h default, deployment-configurable within [1h, 7d], evaluated live at use-time, lazy atomic transition | Long enough for realistic out-of-band handoff, short enough not to leave a standing unredeemed-code surface |
| Revocation/broadcast (§8) | Forward-only: delivered mail and existing conversation membership untouched; only future direct/queued delivery is gated; broadcast checks membership, not a live link | Predictable audit semantics; avoids silently rewriting conversation history on revocation |

No further open items — all round 1 blockers (endpoint_b/OIDC lifecycle,
match-race handling, endpoint-ownership validation on redemption, audit
event naming, `DIRECTORY_LINK_REQUIRED` in the error contract, unique-pair
behavior against non-active prior links, `home_relay` implementability,
self-link/same-human handling, and confirmation actor-binding) are
resolved in §3–§8, §10, and §4 above.
