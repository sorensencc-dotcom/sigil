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
never authenticates against *this* relay to poll for it. This is the actual
gap federation must close first: today "wrong relay" fails silently, not
loudly.

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
Sigil is pre-1.0 (0.2.1), and existing bare (non-`@`) IDs remain valid
opaque strings forever; nothing auto-migrates them. A relay with no
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
  else it's used (unchanged — see Non-goals).
- **`resolveDomainOrThrow(domain, { timeoutMs = 5000, lookupImpl = dns.promises.lookup } = {})`**
  — async. Uses `lookup` (matches what an actual TCP connect would resolve,
  not a specific record type). Races `lookupImpl` against an independent
  timer, the same pattern `checkRelayConnectivity` already uses in
  `sigil/cli/doctor.mjs` — the bound holds even if `lookupImpl` never
  settles. Classifies failure: `ENOTFOUND`/`ENOTFOUND`-family → throws with
  `.code = 'DNS_NOT_FOUND'`; timeout → `.code = 'DNS_TIMEOUT'`; anything
  else → `.code = 'DNS_LOOKUP_FAILED'`. `lookupImpl` is injectable so tests
  never hit real DNS. **Called only at identity-creation time** (`sigil
  init`) — never per-envelope, never on any relay hot path.

### `sigil init` (`sigil/cli/sigil.mjs`, `sigil/cli/identity.mjs`)

New `--domain <domain>` flag on `cmdInit`.

- Omitted → defaults to the literal sentinel `local`.
- Given → `parseFederatedId`-style syntax validation, then
  `resolveDomainOrThrow` (skipped entirely for `local`). A syntax or DNS
  failure aborts identity creation with the corresponding error code.
- `<name>` (the existing positional arg) gets a new charset check —
  `[a-z0-9_-]+` — so it can never itself contain `@` and corrupt the
  federated shape. (Currently unvalidated; this is new.)
- `createIdentity({ ownerId, endpointId, ... })` callers construct
  `` `ep_${name}@${domain}` `` / `` `usr_${name}@${domain}` `` instead of
  today's bare `` `ep_${name}` `` / `` `usr_${name}` ``.

### `sigil relay up` (`sigil/relay/v1/http-server.mjs`)

New `--domain <domain>` flag, passed through to `createRelayServer` as
`relayDomain` (optional — `undefined` preserves every existing behavior
exactly, no federation-awareness, no new checks run).

When `relayDomain` is set, envelope accept (`POST /v1/envelopes`) gains one
new check, run after existing structural/signature validation and before
persistence:

1. `parseFederatedId(envelope.recipient.endpoint_id)`. Parse failure (bare
   or malformed ID) → `400` with `code: 'MALFORMED_FEDERATED_ID'`. A
   domain-configured relay is opting into the federated world; every
   recipient sent to it must be a well-formed federated ID — this is
   deliberately a *different* error from the next case, so callers can
   distinguish "you addressed this wrong" from "you addressed the wrong
   relay."
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
- **No IDNA/punycode, no IPv6 literals** in v1.
- **No auto-migration** of existing bare IDs; they remain valid forever.
- **No identifier canonicalization.** Only `isLocalDomain`'s domain
  comparison is case-insensitive; nothing is rewritten to lowercase or
  otherwise normalized anywhere identifiers are stored or looked up.

## Testing

- `federated-id.mjs` unit tests: valid/malformed parse (multiple `@`, empty
  local part, empty domain, bad port, bad hostname, the `local` sentinel
  bypassing both grammar and DNS), format round-trip, `isLocalDomain`
  case-insensitivity on the domain / case-sensitivity on the local part,
  `resolveDomainOrThrow` with an injected resolver covering success,
  `ENOTFOUND`, and timeout (racing an unresolving stub, mirroring
  `checkRelayConnectivity`'s existing timeout test).
- `sigil init --domain` tests: default-to-`local` skips DNS, a bad name
  charset is rejected, a bad domain syntax is rejected, a DNS failure
  aborts identity creation, a successful case produces the domain-qualified
  IDs.
- `http-server.test.mjs`: a relay with no `--domain` still accepts a bare
  legacy `endpoint_id` unchanged (regression); a relay with `--domain` set
  accepts a matching-domain federated recipient; rejects a
  different-domain federated recipient with `RECIPIENT_NOT_LOCAL` and the
  right `details`; rejects a bare/malformed recipient with
  `MALFORMED_FEDERATED_ID`.
