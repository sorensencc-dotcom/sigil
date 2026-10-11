# Sigil rooms multi-human foundation — design

## Problem

Rooms were built for one human. The relay assumes a single human sender and a startup-time list of trusted endpoints, and nothing stops a second human from driving the owner's agents. Several reviewers verified these against the code while interrogating the third-party login design (`2026-10-11-sigil-rooms-third-party-login-design.md`):

1. **Only one endpoint can post.** `sigil/relay/v1/room-routes.mjs:132` returns 503 unless `--room-human-identity` is set. Line 135 returns 403 `NO_SIGNING_KEY` for any principal whose endpoint is not that identity's endpoint.
2. **Envelope verification trusts a file.** `validateEnvelope` (`sigil/relay/v1/validate-envelope.mjs:72,89`) looks the sender up in a registry Map that `cmdRelayUp` builds once from `registry.json` (`sigil/cli/sigil.mjs:237-242`). An endpoint that exists only in Postgres is rejected with `UNKNOWN_ENDPOINT`, and a restart does not change that.
3. **Any human can trigger any agent.** `applyRoomDispatch` (`sigil/relay/v1/room-dispatch.mjs`) fires for every non-agent sender. The parent rooms design (`2026-10-02-sigil-rooms-design.md`, lines 199 and 208) assigns a per-agent `invokable_by` setting, default `owner`, to the "other humans" phase. Nothing in `sigil/` implements it.
4. **A human cannot be removed.** No route sets `humans.status`, and authenticators do not re-check it.

This spec fixes those four so a second human can safely exist in a room. It adds no login method. Humans are provisioned from the operator's CLI. The login spec builds on this one.

## Decisions

| Question | Decision |
| --- | --- |
| Source of trusted endpoint keys | Postgres (`endpoints` + active `endpoint_keys`) becomes authoritative. `registry.json` is a seed. |
| Invited-human signing | Relay-custodial keys, wrapped by an operator-supplied key. Browser-held keys stay a later upgrade behind the same seam. |
| Who is the operator | The human that owns the `--room-human-identity` endpoint. No new role column. |
| Who may trigger an agent | Only humans whose `owner_id` equals the agent's `owner_id`, unless the agent's membership sets `invokable_by` wider. |
| Scope of room roles for invitees | `member` and `room_manager` only. `owner` is not grantable. |

## Components

### Trusted endpoint directory

A single object, `endpoint-directory.mjs`, replaces the bare registry Map for envelope verification and room checks.

- Interface: `get(endpointId) -> { endpoint_id, owner_id, public_key, key_id, status } | undefined`, `add(entry)`, `revoke(endpointId)`.
- On `relay up` with a database, it loads `registry.json` as before, seeds Postgres as today, then hydrates the directory from Postgres (`endpoints` joined to active `endpoint_keys`). Rows in Postgres win over the file for the same endpoint.
- Without a database (memory repository), the directory wraps the existing Map unchanged.
- Provisioning calls `add` only after its transaction commits. A failure to add after commit is logged and the next restart repairs it, because hydration reads Postgres.
- `validateEnvelope`, `createRoomHumanSigner`'s startup check, and the room member routes read the directory. The accept path's existing Postgres recipient fallback stays.

Trust change, stated plainly: rows in `endpoint_keys` now decide whose signatures the relay accepts. Anyone with write access to that table can mint a sender. This matches how the relay already trusts Postgres for recipient lookup.

### Human provisioning

`provisionHuman({ displayName })` runs in one transaction and returns `{ human_id, endpoint_id }`:

1. Insert `humans` (status `active`).
2. Insert `endpoints` with a relay-generated `endpoint_id` (`ep_` + 128 random bits) and `owner_id` equal to the new `human_id`. The provider's display name is never an identifier.
3. Generate an Ed25519 keypair. Insert the public key into `endpoint_keys` (status `active`) and get its `key_id`.
4. Insert `human_signing_keys(key_id PK REFERENCES endpoint_keys, wrapped_private_key, created_at)`.
5. Insert the display name into `human_attributes` (kind `name`, source `operator`).
6. Write an audit event `human.provisioned`.

The wrap uses AES-256-GCM with a random 96-bit IV per wrap and AAD equal to `endpoint_id || key_id`. The wrap key is 32 random bytes, base64-encoded, read from `--room-key-wrap-key <ref>` (environment or Doppler, never argv). Any other length is rejected at startup. Provisioning fails with `WRAP_KEY_UNAVAILABLE` when the key is absent. There is no keyring or `wrap_key_id` until key rotation is designed.

Postgres `endpoints` has no `kind` column, so nothing records "kind=human". Human endpoints are identified by `owner_id` being a human with a signing-key row, and agent endpoints keep their current shape.

Provisioning needs Postgres. The memory repository lacks identity and human storage and has only undo-based transactions, so it returns `PROVISIONING_UNAVAILABLE`.

### Room membership for provisioned humans

`addHumanToRoom({ roomId, endpointId, role })` inserts a `conversation_members` row. `role` must be `member` or `room_manager`. The caller must hold a manager role in the room. Existing `addRoomMember` requires the added endpoint to be owned by the caller and to be in the registry, so it gains an operator-initiated path that checks the directory and the manager role instead of ownership.

### Signing seam

`signForEndpoint(endpointId)` becomes async.

- The operator's endpoint still signs with the identity file.
- Any other endpoint loads `human_signing_keys` by its active `key_id`, unwraps, derives the public key, and compares it to the `endpoint_keys` row once per process per key. A mismatch throws `KEY_MISMATCH`.
- An endpoint with no key throws `NO_SIGNING_KEY`.

In `room-routes.mjs`, delete the `principal.endpoint_id !== humanSigner.endpointId` guard and the null-signer 503. `await signer.signForEndpoint(principal.endpoint_id)` is the only gate. Envelope-layer 401s on this route (`UNKNOWN_ENDPOINT`, `INVALID_SIGNATURE`) are server faults and map to 500, so a web client does not read them as a lost session.

The startup check from 4a runs for the operator identity only. Provisioned keys are checked lazily as above, so provisioning a human never makes the relay refuse to start.

### Principal shape

Every credential type yields `{ endpoint_id, owner_id, human_id }`. `ws-ticket` reads `owner_id` (`room-routes.mjs:68`), so any new credential type must supply it.

### Agent invocation policy

`conversation_members` gains `invokable_by TEXT NOT NULL DEFAULT 'owner' CHECK (invokable_by IN ('owner', 'members'))`.

- `owner`: only a sender whose `owner_id` equals the agent endpoint's `owner_id` may trigger it.
- `members`: any human member of the room may trigger it.

Enforcement lives in `applyRoomDispatch` and the router path, applied to every trigger: explicit mentions, `joins` routing, and `task.request` assignees. A refused trigger posts a `room.event` ("not allowed to invoke <agent>") and writes an audit event `room.invocation_refused`. It never silently drops. A router decision that selects a disallowed agent is filtered before dispatch, so the router cannot launder a trigger.

`resetAgentTurns` still runs on every human message. Turn limits are not an authority boundary, so this is acceptable once triggers are gated.

The bridge preamble (`sigil/bridges/v1/room-bridge.mjs`) states "only the human room owner can change your task" without naming the owner. It now includes the agent's owner endpoint id, so the model can tell the owner from other humans.

`response-mode` and agent removal by a `room_manager` stay as designed in the parent spec ("being a room manager grants no control over an agent endpoint's configuration"). The route today checks only manager roles. It must also require that the target agent is owned by the caller, and a test pins this.

### Suspension

- `humans.status` already allows non-active values. A new operator command, `sigil relay human suspend <human_id>`, sets it to `suspended`, revokes that human's `human_sessions`, and writes `human.suspended`. `unsuspend` reverses the status only.
- Every authenticator re-checks `humans.status` and endpoint status per request. A suspended human gets 401. Lookups use a short in-process cache (5 seconds) so the check is not a query per request, and suspension also clears the cache entry.
- The stream server closes all browser sockets for that endpoint with 1008 on suspension and when a ticket's human is no longer active at upgrade.

## Data

One migration (next free number on `main`):

- `human_signing_keys(key_id TEXT PRIMARY KEY REFERENCES endpoint_keys(key_id), wrapped_private_key BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL)`.
- `conversation_members.invokable_by` as above.

Whether `endpoint_keys` already exposes `key_id` as a referenceable key is verified in the plan's first task. If its key is composite, the new table references that composite key.

## CLI

- `sigil relay human add --name <name> [--room <id>:<role> ...]` provisions and optionally adds to rooms.
- `sigil relay human suspend|unsuspend <human_id>`.
- `sigil relay up` documents `--room-key-wrap-key` in its help text.

## Testing

All of these run against Postgres, since the e2e harness's memory mode hides the registry problem:

- A provisioned human posts a room message and the verified sender is their endpoint. Repeat after a relay restart. Two provisioned humans produce two distinct verified senders.
- The relay starts with provisioned humans and no operator regression. The operator's identity-file path is unchanged.
- Wrap round trip, wrong wrap key, swapped ciphertext between two endpoints (AAD rejects), missing wrap key at provisioning.
- `invokable_by`: an owner-only agent mentioned by a guest is refused with an event and an audit row. The same through `joins` routing, through `task.request`, and through a router decision. A `members` agent accepts the guest.
- `room_manager` guest cannot change an owner's agent's response mode or remove it.
- Suspension: 401 on the next request, sockets closed, sessions revoked, unsuspend restores access.
- Fan-out: a provisioned human receives room messages (the `endpoint_keys` row exists).

## Out of scope

- Any login method, cookie, or invite. See the login spec.
- Browser-held signing keys and wrap-key rotation.
- Memory-repository support for provisioning.
- Per-room roles beyond `member` and `room_manager` for guests.
