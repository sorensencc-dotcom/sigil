# Sigil rooms multi-human foundation — design

## Problem

Rooms were built for one human. The relay assumes a single human sender and a startup-time list of trusted endpoints, and nothing stops a second human from driving the owner's agents. Reviewers verified these against the code while interrogating the third-party login design (`2026-10-11-sigil-rooms-third-party-login-design.md`):

1. **Only one endpoint can post.** `sigil/relay/v1/room-routes.mjs:132` returns 503 unless `--room-human-identity` is set. Line 135 returns 403 `NO_SIGNING_KEY` for any principal whose endpoint is not that identity's endpoint.
2. **Envelope verification trusts a file.** `validateEnvelope` (`sigil/relay/v1/validate-envelope.mjs:72,89`) looks the sender up in a registry Map that `cmdRelayUp` builds once from `registry.json` (`sigil/cli/sigil.mjs:237-242`). An endpoint that exists only in Postgres is rejected with `UNKNOWN_ENDPOINT`, and a restart does not change that.
3. **Any human can trigger any agent.** `applyRoomDispatch` (`sigil/relay/v1/room-dispatch.mjs`) fires for every non-agent sender, and the invocations route dispatches router-selected agents with no owner check (`room-routes.mjs:305-313`). The parent rooms design (`2026-10-02-sigil-rooms-design.md`, lines 199 and 208) assigns a per-agent `invokable_by` setting, default `owner`, to the "other humans" phase. Nothing in `sigil/` implements it.
4. **A human cannot be removed.** No route sets `humans.status`, and authenticators do not re-check it.
5. **Agent versus human is decided by `kind` on the registry entry.** `createBearerAuthenticator` (`transport-auth.mjs`) gives `human_id` to any endpoint whose `kind !== 'agent'`. Postgres `endpoints` has no `kind` column, but the startup seed writes `ep.kind` into `endpoints.runtime` (`sigil.mjs:261-264`).

This spec fixes those so a second human can safely exist in a room. It adds no login method. Humans are provisioned from the operator's CLI. The login spec builds on this one.

## Decisions

| Question | Decision |
| --- | --- |
| Source of trusted endpoint keys | Postgres (`endpoints` + `endpoint_keys`) becomes authoritative. `registry.json` is a seed that can only add missing rows. |
| Invited-human signing | Relay-custodial keys, wrapped by an operator-supplied key. Browser-held keys stay a later upgrade behind the same seam. |
| Who is the operator | The human that owns the `--room-human-identity` endpoint. No new role column. |
| Who may trigger an agent | The policy subject is always a human: the original trigger sender. Owner-only unless the agent's membership says `members`. |
| How the CLI reaches the running relay | Postgres `LISTEN/NOTIFY`. No new port and no new authenticated route. |
| Room roles for invitees | `member` and `room_manager` only. `owner` is not grantable. |

## Components

### Trusted endpoint directory

`endpoint-directory.mjs` replaces the bare registry Map for envelope verification, authentication, and room checks.

**Entry shape.** A superset of the file Map's entry (same fields every current consumer reads), plus a key set:

```
{ endpoint_id, owner_id, kind: 'human' | 'agent', status,
  keys: Map<key_id, { public_key: KeyObject, status, valid_from, valid_until }> }
```

- `kind` is read from `endpoints.runtime` (`'human'` or `'agent'`) when hydrating from Postgres, and from `ep.kind ?? 'agent'` for file rows, matching the seed. It is never inferred from ownership or from the presence of a key. `createBearerAuthenticator`, `isAgentCaller`, `isAgentMember`, and `createRoomHumanSigner` keep reading `kind` as today, and an agent credential never receives `human_id`.
- `keys` carries every `endpoint_keys` row with its status and validity window. Verification selects the exact key by `signature.key_id` and enforces `valid_from` and `valid_until`, as `validateEnvelope` already does (`validate-envelope.mjs:96`). No single "the key" is chosen by join order.
- `public_key` is a `KeyObject` built with `crypto.createPublicKey({ key, format: 'der', type: 'spki' })` from `endpoint_keys.public_key`. A raw Buffer would fail `crypto.verify` and break `createRoomHumanSigner`'s `export({ type: 'spki' })`.

**Interface.** Synchronous `get(endpointId)` over the hydrated cache. Asynchronous `resolve(endpointId)`, which does `get` and on a miss loads that one endpoint from Postgres and caches it. `add(entry)`, `refresh(endpointId)`, `revoke(endpointId)`. The accept path, authenticators, and room routes use `resolve`. The plan's first task lists every current `registry.get` call site and moves each to the directory.

**Startup.**
1. Load `registry.json` as today.
2. Seed Postgres from it with insert-only semantics: `ON CONFLICT (endpoint_id) DO NOTHING`. The current seed runs `DO UPDATE SET status = 'active'` (`sigil.mjs:260-264`), which would silently reactivate an endpoint revoked in Postgres on every restart. The seed never writes `status` on an existing row. If a file row's `owner_id` or public key conflicts with the Postgres row, startup fails with `REGISTRY_CONFLICT`.
3. Hydrate the directory from Postgres.

Without a database (memory repository), the directory wraps the existing Map unchanged.

**Trust change, stated plainly.** Rows in `endpoint_keys` now decide whose signatures the relay accepts. Anyone with write access to that table can mint a sender. This matches how the relay already trusts Postgres for recipient lookup.

### Reaching the running relay

CLI commands (`human add`, `human suspend`, `human unsuspend`, `agent set-invokable`) run as separate processes with their own pool, so they cannot touch the relay's memory. After their transaction commits, they `NOTIFY sigil_admin` with a JSON payload `{ type, endpoint_id?, human_id? }`.

The relay holds one dedicated `LISTEN sigil_admin` connection. On each notification it:
- `refresh(endpoint_id)` the directory entry, which re-reads status and keys.
- Clears the human-status cache entry.
- On `human.suspended`, calls `stream.closeEndpoint(endpoint_id, 1008)`.

If the listener connection drops, the relay reconnects with backoff and, on reconnect, rehydrates the whole directory and clears the cache, so a missed notification is repaired. `NOTIFY` is a latency optimization over three safety nets, so correctness does not depend on delivery:
1. `resolve` load-through on a directory miss.
2. The status cache TTL of 5 seconds.
3. Stream upgrade re-reads `humans.status` and `endpoints.status` at the moment of upgrade, and the stream server checks the ticket's human once per minute for live sockets.

`createStreamServer` gains `closeEndpoint(endpointId, code)`, which closes that endpoint's browser sockets. Today it has `notify`, `notifyRoom`, and a whole-server `close` only (`stream-server.mjs:87-110`).

### Human provisioning

`provisionHumanTx(client, { displayName, displaySource, verification })` runs on a caller-supplied transaction client and returns `{ human_id, endpoint_id, key_id }`. Callers own the transaction and call `directory.add` or send `NOTIFY` only after their outer commit succeeds. The CLI's `human add` is the simplest caller.

Rows written, with every NOT NULL column populated:

1. `humans(human_id, status='active', created_at)`. `human_id` is `hum_` + 128 random bits, hex.
2. `endpoints(endpoint_id, owner_id=human_id, runtime='human', installation_id='install_' + endpoint_id, display_name=<name or endpoint_id>, status='active', created_at)`. `endpoint_id` is `ep_` + 128 random bits, hex, relay-generated. The display name is a label and never an identifier.
3. `endpoint_keys(...)` with the new Ed25519 public key, status `active`, no `valid_until`. `key_id` is relay-generated.
4. `human_signing_keys(key_id PK REFERENCES endpoint_keys, wrapped_private_key, created_at)`.
5. `human_attributes` with every NOT NULL column of the table in `003_plugin_connector_auth.sql` populated (`attribute_id` random, kind `name`, value as UTF-8 bytes, observed and created times set). `source` and `verification_state` come from the caller. The operator CLI passes `operator` and `unverified`. The login flow passes the provider name and `provider_asserted`, so a provider-supplied name never claims operator provenance. When no name is supplied the fallback is the endpoint id.
6. An audit event `human.provisioned`.

**Key wrap.** AES-256-GCM with a random 96-bit IV per wrap. AAD is `endpoint_id + "\0" + key_id`. `wrapped_private_key` is laid out as `iv (12) || tag (16) || ciphertext`. The wrap key is 32 random bytes, base64-encoded, from `--room-key-wrap-key <ref>` (environment or Doppler, never argv). Any other length is rejected at startup. Provisioning fails with `WRAP_KEY_UNAVAILABLE` when the key is absent. There is no keyring or `wrap_key_id` until key rotation is designed.

Provisioning needs Postgres. The memory repository returns `PROVISIONING_UNAVAILABLE`.

### Room membership for provisioned humans

`addHumanToRoomTx(client, { roomId, endpointId, role })` inserts a `conversation_members` row with `invokable_by` unset (humans) and the given role, which must be `member` or `room_manager`. The caller must hold a manager role in the room, checked on the same client with the creator's membership row locked (`SELECT ... FOR UPDATE`), so a concurrent removal cannot slip between the check and the insert. Existing `addRoomMember` requires the added endpoint to be owned by the caller and present in the registry. The operator path checks the directory and the manager role instead.

### Signing seam

`signForEndpoint(endpointId)` becomes async.

- The operator's endpoint still signs with the identity file.
- Any other endpoint loads `human_signing_keys` by its active `key_id`, unwraps with the configured key, derives the public key, and compares it to the `endpoint_keys` row once per process per key. A mismatch throws `KEY_MISMATCH`.
- An endpoint with no key throws `NO_SIGNING_KEY`.

In `room-routes.mjs`, delete the `principal.endpoint_id !== humanSigner.endpointId` guard and the null-signer 503. `await signer.signForEndpoint(principal.endpoint_id)` is the only gate. Envelope-layer 401s on this route (`UNKNOWN_ENDPOINT`, `INVALID_SIGNATURE`) are server faults and map to 500, so a web client does not read them as a lost session.

The 4a startup check runs for the operator identity only. Provisioned keys are checked lazily as above, so provisioning a human never makes the relay refuse to start.

### Principal shape

Every credential type yields `{ endpoint_id, owner_id, human_id? }`. `human_id` is present only for human endpoints. Agent credentials never receive it. `ws-ticket` reads `owner_id` (`room-routes.mjs:68`), so any new credential type must supply it.

### Agent invocation policy

`conversation_members` gains `invokable_by TEXT NOT NULL DEFAULT 'owner' CHECK (invokable_by IN ('owner', 'members'))`. It applies to agent members. Every member query returns it.

`mayInvoke(triggerHumanOwnerId, targetAgent)` is the single check:
- `owner`: allowed only when `triggerHumanOwnerId` equals the agent endpoint's `owner_id`.
- `members`: allowed for any human member of the room.

**Who is the trigger human.**
- Human message with `mentions`, a `task.request` assignee, or `joins` routing: the message's sender.
- Router-selected invocation: the router is an agent, so its `owner_id` is not the subject. `POST /v1/rooms/{id}/invocations` loads the trigger envelope, requires its sender to be a human member, and applies `mayInvoke` to that human's `owner_id` for each selected agent before `dispatchToTarget`. The web client never sends `mentions`, so unmentioned composer messages always take this path, and it is the path tests must cover.
- Agent-authored trigger (agent to agent): the policy subject is the sending agent's `owner_id`. An agent only runs because an invocation already passed this check, so a guest cannot launder through agents. An agent cannot trigger a target its owner could not.

A refused trigger posts a `room.event` ("not allowed to invoke <agent>") and writes `room.invocation_refused`. It never silently drops. A router decision naming a disallowed agent is filtered before dispatch.

**Setting it.** `sigil relay agent set-invokable --room <id> --agent <endpoint_id> --mode owner|members` and `PATCH /v1/rooms/{id}/members/{endpoint_id}` with `{ invokable_by }`. Only the agent's owner may change it, and a `room_manager` guest cannot.

The bridge preamble (`sigil/bridges/v1/room-bridge.mjs`) says "only the human room owner can change your task" without naming the owner. It now includes the agent's owner endpoint id.

**Other room controls.**
- `response-mode` change and agent removal require that the target agent is owned by the caller, not only a manager role (the parent spec: "being a room manager grants no control over an agent endpoint's configuration").
- `POST /v1/rooms/{id}/stop` cancels invocations only for agents the caller owns. The operator therefore stops everything of theirs, and a guest stops nothing of the operator's.
- `POST /v1/rooms` (create room) is allowed only for the operator's endpoint. A guest who created a room would become its `owner`, outside the intended guest roles.

### Suspension

`sigil relay human suspend <human_id>` runs one transaction that sets `humans.status='suspended'`, sets that human's `endpoints.status='suspended'`, revokes their `human_sessions`, and writes `human.suspended`. Then it sends `NOTIFY`. `unsuspend` reverses both statuses and does not restore revoked sessions.

Suspending the endpoint matters: `endpointIsActive` and `lookupRecipientEndpoint` read `endpoints.status` and an active `endpoint_keys` row, and without it a suspended guest keeps receiving deliveries that count against `inboxDepthLimit`. A suspended member is absent from fan-out, and a test pins that.

Every authenticator re-checks `humans.status` and endpoint status per request through a 5-second in-process cache, cleared by `NOTIFY`. A suspended human gets 401.

## Data

One migration (next free number on `main`):

- `human_signing_keys(key_id TEXT PRIMARY KEY REFERENCES endpoint_keys(key_id), wrapped_private_key BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL)`.
- `conversation_members.invokable_by` as above.

The plan's first task confirms `endpoint_keys.key_id` is a referenceable single-column key. If it is composite, the new table references the composite key.

## CLI

- `sigil relay human add --name <name> [--room <id>:<role> ...]`.
- `sigil relay human suspend|unsuspend <human_id>`.
- `sigil relay agent set-invokable --room <id> --agent <endpoint_id> --mode owner|members`.
- `sigil relay up` documents `--room-key-wrap-key`.

## Testing

All of these run against Postgres, because the e2e harness's memory mode shares and mutates the registry Map and would hide the failure:

- A provisioned human posts a room message and the verified sender is their endpoint. Repeat after a relay restart. Two provisioned humans produce two distinct verified senders.
- `kind` preserved: an agent bearer token authenticates without `human_id` after hydration, and cannot create rooms, add members, or post as a human.
- Seed: a revoked endpoint stays revoked after restart. A file row conflicting with Postgres fails startup with `REGISTRY_CONFLICT`.
- Multi-key endpoint: a retiring key still verifies inside its window, a future-dated key is rejected before `valid_from`, and verification selects by `key_id`.
- Cross-process: `human add` and `suspend` run from a second CLI process against a live relay and a live stream socket. The directory updates, the cache clears, and the socket closes with 1008. A dropped listener connection recovers on reconnect.
- Transaction composition: a failure after `provisionHumanTx` inside an outer transaction leaves no human, endpoint, or key.
- Wrap: round trip, wrong key, swapped ciphertext between two endpoints (AAD rejects), missing key at provisioning.
- `invokable_by`: an owner-only agent mentioned by a guest is refused with an event and an audit row. The same through `joins` routing, `task.request`, and an unmentioned composer message that the router answers. An agent-authored trigger follows its owner. A `members` agent accepts the guest. A guest `room_manager` cannot change a mode, remove an agent, or call `set-invokable`.
- Guest `stop` cancels none of the operator's invocations. Guest `POST /v1/rooms` returns 403.
- Suspension: 401 on the next request, sockets closed, sessions revoked, fan-out skips the endpoint, unsuspend restores access.
- A provisioned human receives room messages (the `endpoint_keys` row exists).

## Out of scope

- Any login method, cookie, or invite. See the login spec.
- Browser-held signing keys and wrap-key rotation.
- Memory-repository support for provisioning.
- Per-room roles beyond `member` and `room_manager` for guests.
