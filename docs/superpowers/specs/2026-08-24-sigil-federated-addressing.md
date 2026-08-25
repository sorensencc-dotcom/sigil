# Sigil federated addressing — design

## Problem

Sigil relays are pairwise/self-hosted-per-group; there is no way for an
endpoint on one relay to be addressed by an endpoint on another. Per
`docs/meta/sigil-cli-roadmap.md`, a federated relay model (independent relay
operators, endpoints route between them, à la email/Matrix) is the intended
"sweet spot" over a single centrally-hosted relay, with self-hosting as a
longer-term commercial option. Federation decomposes into: (1) addressing,
(2) inter-relay trust/discovery, (3) inter-relay routing, (4) cross-federation
directory/presence, (5) operational tooling. This spec covers **only (1)**.

Today `endpoint_id`/`owner_id` are bare, relay-local, opaque strings (e.g.
`ep_codex`, `usr_codex_owner`). A recipient is never checked against the
registry at envelope-accept time (`validate-envelope.mjs` only checks
presence, not existence) — an envelope addressed to an unknown endpoint is
silently accepted and stored, then never delivered, because that endpoint
never authenticates against *this* relay to poll for it. **This spec closes
only the wrong-relay half of that gap** (an envelope addressed to a
different federation member becomes a loud, immediate rejection instead of
a silent no-op). It does **not** close the unknown-local-recipient half: a
domain-qualified recipient that names a nonexistent endpoint *within* this
relay's own domain is still silently accepted and stored today, unchanged
by this spec — that's a pre-existing gap in the whole system (it already
happens on a purely local, non-federated relay), orthogonal to federation,
and is called out as a non-goal below rather than bundled in here.

A repo-wide survey (see commit history for this spec) confirmed every
consumer of these IDs — Postgres schema (`TEXT` columns, no CHECK/length
constraints), in-memory registry `Map`s, capability grants, directory-trust,
transport-auth, envelope validation — treats them as opaque strings compared
by exact equality. No parsing, prefix-stripping, or regex constraint on the
ID format exists anywhere except the one generation site
(`sigil/cli/sigil.mjs` `cmdInit`). This makes the rename far less invasive
than it would first appear.

## Decision

`endpoint_id`/`owner_id` become domain-qualified: `<local-part>@<domain>`
(e.g. `ep_codex@relay.example.com`). Clean break, no migration tooling —
Sigil is pre-1.0 (0.2.1). Bare (non-`@`) IDs remain supported only on
relays that have not opted into federated addressing (no `--domain`
configured); nothing auto-migrates them, and they are never valid on a
domain-configured relay (see the accept-time check below). A relay with no
configured domain never runs any of the new logic below and behaves exactly
as it does today.

### `sigil/relay/v1/federated-id.mjs` (new)

Pure parsing/formatting/validation, no I/O except the one DNS check below.

- **`parseFederatedId(id)`** → `{ localPart, domain }`. Throws `Error` with
  `.code` set to one of:
  - `MALFORMED_FEDERATED_ID` — not exactly one `@`, or empty local part.
  - `INVALID_DOMAIN_SYNTAX` — domain fails the grammar below.
  - `INVALID_PORT` — a `:port` suffix present but not numeric 1–65535.
- **Domain grammar:** RFC 1035-style labels (letters, digits, hyphens; no
  underscores), dot-separated, max 253 chars total / 63 per label, ASCII
  only (no IDNA/punycode in v1). Two literal exceptions, valid without dots:
  the sentinel `local` and the well-known name `localhost`.
  - **`local` is a reserved sentinel**: matched by exact string comparison
    *before* grammar/DNS validation. It skips DNS resolution entirely (see
    below) and is never treated as a routable network domain by any other
    part of the system.
- **Port:** optional `:port`, numeric, range 1–65535. No IPv6 literals in
  v1 — federation identity means a real domain, not an IP.
- **`formatFederatedId({ localPart, domain })`** → the joined string. Pure
  formatting, no validation (call `parseFederatedId` on the result if
  validation is needed).
- **`isLocalDomain(id, thisRelayDomain)`** → boolean. Parses `id`, compares
  its domain to `thisRelayDomain` **case-insensitively** (DNS semantics).
  The local-part is never compared here and stays case-sensitive wherever
  else it's used (unchanged — see Non-goals). Case-insensitivity applies
  only at comparison time; stored/formatted IDs always preserve their
  original casing — nothing is lowercased on write. Domain equality
  includes the port when present: `example.com` and `example.com:443` are
  distinct domains, not equivalent.
- **`resolveDomainOrThrow(domain, { timeoutMs = 5000, lookupImpl = dns.promises.lookup } = {})`**
  — async. **Strips the port before resolving**: DNS has no notion of
  ports, so if `domain` is `relay.example.com:8443`, only
  `relay.example.com` is ever passed to `lookupImpl` (the host is split
  off internally; callers pass the same `--domain` value they'd pass
  anywhere else, they never need to pre-strip it themselves). Uses
  `lookup` (matches what an actual TCP connect would resolve, not a
  specific record type). Races `lookupImpl` against an independent timer,
  the same pattern `checkRelayConnectivity` already uses in
  `sigil/cli/doctor.mjs` — the bound holds even if `lookupImpl` never
  settles. Classifies failure: `ENOTFOUND`/`ENOTFOUND`-family → throws
  with `.code = 'DNS_NOT_FOUND'`; timeout → `.code = 'DNS_TIMEOUT'`;
  anything else → `.code = 'DNS_LOOKUP_FAILED'`; the thrown error also
  carries structured fields `{ domain, timeoutMs }` (and, for
  `DNS_LOOKUP_FAILED`, `cause` set to the original resolver error) so
  callers get diagnosable detail without leaking `lookupImpl` internals
  beyond that. `lookupImpl` is injectable so tests never hit real DNS.
  **Called only at identity-creation time** (`sigil init`) — never
  per-envelope, never on any relay hot path, and (see below) never at
  `sigil relay up` time either.

### `sigil init` (`sigil/cli/sigil.mjs`, `sigil/cli/identity.mjs`)

New `--domain <domain>` flag on `cmdInit`.

- Omitted → defaults to the literal sentinel `local`.
- Given → `parseFederatedId`-style syntax validation, then
  `resolveDomainOrThrow` (skipped entirely for `local`). A syntax or DNS
  failure aborts identity creation with the corresponding error code.
- `<name>` (the existing positional arg) gets a new charset check —
  `[a-z0-9_-]+` — so it can never itself contain `@` and corrupt the
  federated shape. (Currently unvalidated; this is new.) Enforced only at
  identity-creation time — existing identity files are never re-parsed or
  retroactively invalidated against this charset.
- `createIdentity({ ownerId, endpointId, ... })` callers construct
  `` `ep_${name}@${domain}` `` / `` `usr_${name}@${domain}` `` instead of
  today's bare `` `ep_${name}` `` / `` `usr_${name}` ``.

### `sigil relay up` (`sigil/relay/v1/http-server.mjs`)

New `--domain <domain>` flag. Validated for syntax (the same grammar
`parseFederatedId`'s domain-parsing enforces, including the `local`
sentinel and port rules) **before** the relay starts listening — a
malformed `--domain` aborts `cmdRelayUp` immediately with
`INVALID_DOMAIN_SYNTAX`, rather than starting a relay that would then
reject every single recipient unpredictably. **No DNS resolution at relay
startup** — deliberately asymmetric with `sigil init`: a relay's own
domain is what *other* parties resolve to reach it, the relay itself
doesn't need to resolve its own name to serve traffic, and requiring a
live DNS dependency just to run `sigil relay up --domain local` (a
same-machine dev/test relay) would be actively wrong. Once validated, the
raw string is passed through to `createRelayServer` as `relayDomain`
(optional — `undefined` preserves every existing behavior exactly, no
federation-awareness, no new checks run).

When `relayDomain` is set, envelope accept (`POST /v1/envelopes`) gains one
new check, run after existing structural/signature validation and before
persistence:

1. `parseFederatedId(envelope.recipient.endpoint_id)`. Parse failure (bare
   or malformed ID) → `400` with `code: 'MALFORMED_FEDERATED_ID'`. A
   domain-configured relay is opting into the federated world; every
   recipient sent to it must be a well-formed federated ID — this is
   deliberately a *different* error from the next case, so callers can
   distinguish "you addressed this wrong" from "you addressed the wrong
   relay." Bare IDs remain valid only on relays with no configured
   domain — a domain-configured relay never accepts them.
2. `isLocalDomain(recipient.endpoint_id, relayDomain)`. If false → `400`
   with `code: 'RECIPIENT_NOT_LOCAL'`, `details: { recipientDomain,
   relayDomain }` (existing envelope error response shape — `request_id`,
   `code`, `message`, `details`).
3. If both pass, accept proceeds exactly as today — the recipient is local,
   delivery is the existing pull/poll/stream path.

This is the whole of what this sub-project delivers operationally: a relay
that knows its own domain now **loudly rejects** mis-addressed envelopes at
accept time, replacing today's silent accept-and-never-deliver. It does
**not** forward a non-local envelope anywhere (sub-project #3).

## Non-goals

- **No auto-forwarding.** A relay never contacts another relay to deliver a
  non-local envelope. Rejection only. Routing is sub-project #3.
- **No hot-path DNS.** `resolveDomainOrThrow` runs only at `sigil init`
  time.
- **No parsing of these IDs outside `federated-id.mjs`.** Every other
  consumer (registry `Map`s, Postgres columns, capability grants,
  directory-trust, transport-auth) keeps treating the full ID as an opaque
  string, exact-match, completely unchanged — confirmed safe by the survey
  above.
- **No IDNA/punycode, no IPv6 literals** in v1. Future versions may add
  IDNA/punycode support; v1 stores and compares domains strictly as ASCII.
- **No auto-migration** of existing bare IDs; they remain valid forever on
  relays that stay unconfigured for federation (see Decision).
- **No identifier canonicalization.** Only `isLocalDomain`'s domain
  comparison is case-insensitive; nothing is rewritten to lowercase or
  otherwise normalized anywhere identifiers are stored or looked up.
  Domain case-insensitivity applies only at comparison time, never at
  storage/formatting time.
- **No unknown-local-recipient check.** This spec only distinguishes
  local-domain vs. foreign-domain recipients (`RECIPIENT_NOT_LOCAL`). It
  does not check whether a local-domain recipient actually exists in the
  registry — that gap predates federation entirely (see Problem) and is
  tracked separately as a candidate `RECIPIENT_NOT_FOUND` check, not
  bundled into this spec.
- **No relay-startup DNS resolution.** `sigil relay up --domain` validates
  syntax only; DNS resolution happens exclusively at `sigil init` time.

## Testing

- `federated-id.mjs` unit tests: valid/malformed parse (multiple `@`, empty
  local part, empty domain, bad port, bad hostname, the `local` sentinel
  bypassing both grammar and DNS), format round-trip, `isLocalDomain`
  case-insensitivity on the domain / case-sensitivity on the local part /
  port significance (`example.com` vs `example.com:443` are not local to
  each other; same host+port with differing case *is* local), and
  `resolveDomainOrThrow` with an injected resolver covering: success on a
  bare host, **success on a `host:port` domain where the injected resolver
  asserts it received only the host, never the port**, `ENOTFOUND`
  (asserting `.code === 'DNS_NOT_FOUND'` and the structured `{domain,
  timeoutMs}` fields), and timeout (racing an unresolving stub, mirroring
  `checkRelayConnectivity`'s existing timeout test).
- `sigil init --domain` tests: default-to-`local` skips DNS, a bad name
  charset is rejected, a bad domain syntax is rejected, a DNS failure
  aborts identity creation, a successful case produces the domain-qualified
  IDs, validation happens before any file is written (a failed `--domain`
  leaves no partial identity file on disk).
- `sigil relay up --domain` tests: a malformed `--domain` aborts startup
  with `INVALID_DOMAIN_SYNTAX` before the server binds a port (assert no
  listener was created); no DNS lookup is attempted at startup (inject a
  `lookupImpl`/resolver spy and assert it's never called).
- `http-server.test.mjs`: a relay with no `--domain` still accepts a bare
  legacy `endpoint_id` unchanged (regression); a relay with `--domain` set
  accepts a matching-domain federated recipient; rejects a
  different-domain federated recipient with `RECIPIENT_NOT_LOCAL` and the
  right `details`; rejects a bare/malformed recipient with
  `MALFORMED_FEDERATED_ID`; two recipients differing only in local-part
  case (`ep_Foo@x.com` vs `ep_foo@x.com`) are treated as distinct
  endpoints by the registry/delivery path, proving local-part
  case-sensitivity holds through actual registry lookup, not just inside
  the `federated-id.mjs` parser.
