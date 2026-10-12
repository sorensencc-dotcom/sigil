# Sigil rooms multi-human foundation — design

## Problem

Rooms were built for one human. The relay assumes a single human sender and a startup-time list of trusted endpoints, and nothing stops a second human from driving the owner's agents. Reviewers verified these against the code while interrogating the third-party login design (`2026-10-11-sigil-rooms-third-party-login-design.md`):

1. **Only one endpoint can post.** `sigil/relay/v1/room-routes.mjs:132` returns 503 unless `--room-human-identity` is set. Line 135 returns 403 `NO_SIGNING_KEY` for any principal whose endpoint is not that identity's endpoint.
2. **Envelope verification trusts a file.** `validateEnvelope` (`sigil/relay/v1/validate-envelope.mjs:72,89`) looks the sender up in a registry Map that `cmdRelayUp` builds once from `registry.json` (`sigil/cli/sigil.mjs:237-242`). An endpoint that exists only in Postgres is rejected with `UNKNOWN_ENDPOINT`, and a restart does not change that.
3. **Any human can trigger any agent.** `applyRoomDispatch` (`sigil/relay/v1/room-dispatch.mjs`) fires for every non-agent sender, and the invocations route dispatches router-selected agents with no owner check (`room-routes.mjs:305-313`). The parent rooms design (`2026-10-02-sigil-rooms-design.md`, lines 199 and 208) assigns a per-agent `invokable_by` setting, default `owner`, to the "other humans" phase. Nothing in `sigil/` implements it.
4. **A human cannot be removed.** No route sets `humans.status`, and authenticators do not re-check it.
5. **Agent versus human is decided by `kind` on the registry entry.** `createBearerAuthenticator` (`transport-auth.mjs`) gives `human_id` to any endpoint whose `kind !== 'agent'`. Postgres `endpoints` has no `kind` column. The startup seed writes `ep.kind` into `endpoints.runtime` (`sigil.mjs:261-264`), but `runtime` is an unrelated field that also holds `relay` (the room system endpoint, `postgres-repository.mjs:495`) and `federated` (shadow senders, `postgres-repository.mjs:826`). A file row with no `kind` is human in the Map but seeds as `'agent'`.

This spec fixes those so a second human can safely exist in a room. It adds no login method. Humans are provisioned from the operator's CLI. The login spec builds on this one.

## Decisions

| Question | Decision |
| --- | --- |
| Source of trusted endpoint keys | Postgres (`endpoints` + `endpoint_keys`) becomes authoritative. `registry.json` is a seed that can only add missing rows. |
| Invited-human signing | Relay-custodial keys, wrapped by an operator-supplied key. Browser-held keys stay a later upgrade behind the same seam. |
| Who is the operator | The human that owns the `--room-human-identity` endpoint. No new role column. |
| Who may trigger an agent | The policy subject is always the human who started the chain, recorded on every `room_invocations` row and carried unchanged through every agent hop. Owner-only unless the agent's membership says `members`. |
| How the CLI reaches the running relay | Postgres `LISTEN/NOTIFY`. No new port and no new authenticated route. |
| Room roles for invitees | `member` and `room_manager` only. `owner` is not grantable. |

## Components

### Trusted endpoint lookup

Postgres (`endpoints` + `endpoint_keys`) is the only source of trust. The relay keeps no in-memory copy of it. `registry.json` is a seed that can only add missing rows (see Startup). Every consumer reads the trust state it needs at the moment it needs it, on the connection it already holds.

`repository.lookupTrustedEndpoint(endpointId, client?)` returns an entry or `null`. It reads on `client` when one is given, so an endpoint created earlier in the same uncommitted transaction is visible, and on the pool otherwise.

**Entry shape.** The file Map's entry has a top-level `key_id` and `public_key`. Four consumers read them today: `validateEnvelope` (`validate-envelope.mjs:97`), `forwardEnvelope` (`accept-envelope.mjs:496-507`), the p2p PeerId binding (`p2p-data-protocol.mjs:76-79`), and `createRoomHumanSigner` (`room-human-signer.mjs:16`). The entry drops them, because with several keys no top-level key is canonical:

```
{ endpoint_id, owner_id, kind: 'human' | 'agent', status,
  keys: Map<key_id, { key_id, public_key: KeyObject, status, valid_from, valid_until }> }
```

Each consumer migrates to a stated rule:

- `validateEnvelope` selects `entry.keys.get(signature.key_id)` and nothing else. The shortcut that treats the entry itself as the key when `signature.key_id === endpoint.key_id` (line 97) is deleted, because it skips the key's validity window and status.
- `forwardEnvelope` (both the synchronous and the queued path return before `validateEnvelope` runs, and the receiving peer verifies only against the `sender_key` the origin relay sends) builds `senderKey` from the key matching `envelope.signature.key_id`, and refuses to forward unless the sender endpoint is `active` and that key passes the "Which keys verify" rule below. Otherwise a retired key, or a key of a revoked endpoint, would still verify at every federated peer, and retiring a compromised key would not stop forgery on the federated path.
- The p2p binding accepts a remote peer whose PeerId derives from any `active` key of the sender.
- `createRoomHumanSigner` and `signForEndpoint` use the endpoint's single signing key (below).
- `agentmail-adapter.mjs:160-162` branches on `registry instanceof Map` and skips its "not registered" and "not active" rejections when the registry is not a Map. The plan migrates it to `lookupTrustedEndpoint`, so it cannot fail open.

**Which keys verify.** A key verifies only when `status` is `active` or `retiring` and now is inside `valid_from`..`valid_until`. An `active` key has a null `valid_until`, so only `valid_from` bounds it. A `retiring` key must have a non-null `valid_until`. A `retired` key never verifies. `validateEnvelope` currently rejects only `status === 'revoked'` (line 101), a value `endpoint_keys.status` cannot hold (`active | retiring | retired`), so a retired key with no `valid_until` verifies forever today. The comparison is replaced, and the retirement code path sets `valid_until`.

**One signing key.** At most one `active` key per endpoint is the signing key. A partial unique index on `endpoint_keys(endpoint_id) WHERE status = 'active'` enforces it. No migration creates this index today, and the migrations cannot show whether production data satisfies it, so the migration handles surplus keys before creating it. For a federated shadow endpoint (`origin_domain IS NOT NULL`) it retires every `active` key except the newest (`status='retired'`, `valid_until` = now), because shadow keys never verify anything locally and exist only to satisfy the `envelopes.signature_key_id` foreign key. For a local endpoint it fails with a message naming every endpoint that has more than one `active` key, so an operator retires the extras by hand. Rotation retires the old key and activates the new one in one transaction. `registerFederatedSender` follows the same rule: in one transaction it retires the shadow endpoint's other `active` keys before inserting a peer's new `key_id`. Without that, the first envelope after a remote key rotation would raise `23505` on the partial index (the `ON CONFLICT (key_id)` arbiter does not cover it), `accept-federated-envelope.mjs` would collapse it to `INVALID_FEDERATION_REQUEST`, and that sender could never deliver again.

**`kind` is its own column.**
- `endpoints.kind TEXT NOT NULL CHECK (kind IN ('human','agent','system'))`, added in this spec's migration. The migration backfills best-effort from what Postgres knows: `runtime = 'relay'` becomes `system`, `runtime = 'human'` becomes `human`, everything else (`agent`, `federated`, and any other runtime) becomes `agent`, so an unknown row never gets `human_id`.
- The file is the source of truth for the endpoints it lists, with a missing `kind` meaning `human` (the default the file Map applies today, `kind !== 'agent'`). A legacy human endpoint, such as an operator whose registry row predates `kind`, was seeded with `runtime = 'agent'` and so backfills wrong. On the first startup after the migration, a listed row whose `kind` differs from the file fails startup with `REGISTRY_CONFLICT`, naming each endpoint with both values (file and Postgres). `--reconcile-kind <endpoint_id>=<kind>` (repeatable) updates Postgres for that endpoint only, and `kind` must equal the file's. A blanket flag is not offered: legacy agent rows with no `kind` in the file would otherwise all become `human` and receive `human_id`, pass the operator room-creation rule, and count as human members. After reconciling, any further difference fails startup.
- Every writer of `endpoints` sets `kind` explicitly, because the column has no default and Postgres checks `NOT NULL` before `ON CONFLICT` arbitration (so `ON CONFLICT (endpoint_id) DO NOTHING` does not protect an install whose row already exists): the startup seed writes the file's `kind`; `provisionHumanTx` writes `human`; `ensureRoomSystemEndpoint` (`postgres-repository.mjs:494-495`) writes `system`; `registerFederatedSender` (`:825-827`) writes `agent`; `createEndpointWithAudit` (`:480`) takes a validated `kind` argument. The plan lists every `INSERT INTO endpoints`, test fixtures included, and a test fails if a writer omits `kind`.
- Memory mode and Postgres apply the same default (`ep.kind ?? 'human'`), so one `registry.json` yields one answer in both.
- `system` endpoints never receive `human_id` and cannot be a local sender. An unrecognized `kind` is refused, never treated as human.
- `createBearerAuthenticator` gives `human_id` only when `kind === 'human'`. Today it withholds it only for `kind === 'agent'`, so `system` and missing kinds would receive it. `isAgentCaller`, `isAgentMember`, and `createRoomHumanSigner` read `kind` from the entry and treat `system` as neither human nor agent member. Because Postgres mode keeps no Map, `lookupTrustedEndpoint` and `lookupRecipientEndpoint` return `kind` and `owner_id` along with `status`.

**Public keys.** `public_key` is a `KeyObject` built with `crypto.createPublicKey({ key, format: 'der', type: 'spki' })` from `endpoint_keys.public_key`. A raw Buffer would fail `crypto.verify`.

**Local endpoints only.** `lookupTrustedEndpoint` returns only rows with `origin_domain IS NULL`. `registerFederatedSender` (`postgres-repository.mjs:817-853`) writes shadow `endpoints` and `endpoint_keys` rows whose key and `key_id` a remote peer chose. Returning them would make a peer-supplied key verify on the local `POST /v1/envelopes` path and skip the federation-only checks (`getActiveFederationDirectoryLink`, the `federation_origin` rate limit, `assertNotRoomConversation`). Shadow keys stay on the federated path's synthetic map (`accept-federated-envelope.mjs`).

**Call sites.**
- **Envelope accept.** The local accept path already runs inside `repository.withTransaction` (`accept-envelope.mjs:256`) and does about ten queries per envelope, including the recipient lookup on that client (line 303). It calls `lookupTrustedEndpoint(senderId, client)` there and passes a one-entry `registered` Map to `validateEnvelope`, which stays synchronous and pure (`validate-envelope.mjs:72`). The federated path already does exactly this (`validate-envelope.mjs:80-83`). Signature verification therefore always sees current status and keys, with no cache to go stale.
- **Other Map consumers.** `accept-envelope.mjs:303` and `accept-federated-envelope.mjs:196` keep the same `?? registered.get(...)` fallback that is removed from `room-policy.mjs:91-93`, and are removed the same way. `accept-envelope.mjs:373-374` reads both the sender's and the recipient's owner from `registered` for the same-owner directory-link exemption. With a one-entry sender Map the recipient's owner would be undefined and every same-owner direct envelope would fail `DIRECTORY_LINK_REQUIRED`, so the recipient's `owner_id` comes from `lookupRecipientEndpoint` instead. `room-routes.mjs:191-195` (`addRoomMember`) reads owner, status, and `kind` from the Map and moves to `lookupTrustedEndpoint`.
- **Authenticators.** Bearer and (in the login spec) cookie authenticators are awaited (`http-server.mjs:344`). One query returns the endpoint's `kind`, `owner_id`, and status together with `humans.status`, cached per endpoint for 5 seconds. A NOTIFY clears the entry.
- **Fan-out.** `endpointIsActive` and `lookupRecipientEndpoint` read Postgres only. The `?? registered.get(...)` fallback (`room-policy.mjs:91-93`) is removed in Postgres mode, because a stale entry would otherwise outvote a suspended row.
- **Stream server.** `createStreamServer` takes the repository and makes its connection handler async. A socket stays out of `clients` and `browserClients` until the liveness check (below) passes. Today `authenticateRequest(request)` is called synchronously (`stream-server.mjs:71`), and a Promise would close every bearer socket with 1008.
- The stream bearer authenticator today returns `{ endpoint_id }` only (`sigil.mjs:327`). It is extended to return `owner_id`, so the Principal shape rule below holds for sockets too. It exists for agents and local clients only: the login spec's public listener attaches a ticket-only handler instead, so a leaked agent token never opens a socket through the proxy.
- Memory repository: `lookupTrustedEndpoint` reads the file Map, whose entries (`registry-store.mjs:35-41`) carry only a top-level `key_id` and `public_key`. The loader normalizes each entry to the new shape (`keys` Map holding that one key as `active`, with `valid_from` the epoch and a null `valid_until`) so the rewritten `validateEnvelope` works in memory mode. The federated path's synthetic sender (`accept-federated-envelope.mjs:150-155`) builds the same shape. The plan's first task lists every `registry.get`, `.set`, and `instanceof Map` call site and moves each.

**Startup.**
1. Load `registry.json` as today.
2. Seed Postgres from it with insert-only semantics for identity: `ON CONFLICT (endpoint_id) DO NOTHING`. The current seed runs `DO UPDATE SET status = 'active'` (`sigil.mjs:260-264`), which would silently reactivate an endpoint revoked in Postgres on every restart. The seed never raises `status`. A file row whose `status` is `revoked` or `suspended` is copied into a less-active Postgres row, in that direction only, so `status: "revoked"` in the file keeps working as a revocation method. If a file row's `owner_id`, `kind`, or public key conflicts with the Postgres row, startup fails with `REGISTRY_CONFLICT`.
3. Start the `LISTEN` connection (below). There is nothing to hydrate.

**Revoking an endpoint.** Making the seed insert-only removes nothing: file-side revocation is still honored (step 2), and `sigil relay endpoint revoke <endpoint_id>` sets `status='revoked'`, retires the endpoint's keys, writes `endpoint.revoked`, and notifies. Nothing in non-test code updates `endpoints.status` today, so the command needs adding.

**Trust change, stated plainly.** Rows in `endpoint_keys` for local endpoints (`origin_domain IS NULL`) now decide whose signatures the relay accepts. Anyone with write access to that table can mint a sender. Federation code writes to the same table, which is why shadow rows are excluded.

### Reaching the running relay

CLI commands (`human add`, `human add-to-room`, `human suspend`, `human unsuspend`, `agent set-invokable`, `endpoint revoke`, and the login spec's `identity revoke`) run as separate processes with their own pool, so they cannot touch the relay's memory. Each calls `pg_notify('sigil_admin', payload)` **inside its own transaction**, so Postgres delivers it at commit and a crash between commit and notify cannot lose it. The payload is `{ type, human_id?, endpoint_id?, room_ids? }` and is fixed-size. `pg_notify` rejects payloads of 8000 bytes or more, and an error inside the transaction rolls the command back, so a payload never carries a list that grows with the data (session ids, member lists). `room_ids` is bounded by the rooms named on the command line.

With no directory to refresh, a notification has three jobs. The relay holds one dedicated `LISTEN sigil_admin` connection, and on each notification it:
- Clears authenticator-cache entries: every endpoint the `human_id` owns, or the named `endpoint_id`.
- Calls `stream.revalidate({ humanId, endpointId })` for `human.suspended`, `endpoint.revoked`, and `identity.revoked`. It runs the liveness check (below) on that human's or endpoint's live sockets now and closes each socket that fails with 1008.
- For `room_ids`, calls the existing `notifyRoomHumans` so open rosters update after a CLI change to membership or `invokable_by`. The call must run inside `repository.withTransaction` or open its own read. `notifyRoomHumans` defaults `client` to `null`, and `listRoomMembers(conversationId, client = this.pool)` applies its default to `undefined` only, so a `null` reaches `null.query`, throws, and the function's `catch` logs it and sends nothing.

**The liveness check** is one function, used at stream upgrade, by `revalidate`, and by the once-a-minute pass. A socket passes when its endpoint is `active` with an active key, its human (if any) is `active`, and, for a socket opened with a session-bearing ticket, the session is not revoked, is inside `expires_at` and the idle window, and its identity is not revoked (the login spec). Checking the endpoint is what makes `endpoint revoke` close an agent's sockets: the human is still active in that case, and the authenticator cache bounds only HTTP.

If the listener connection drops, the relay reconnects with backoff and clears the authenticator cache on reconnect. Delivery is a latency optimization, and what it does not cover is bounded:
1. Signature verification and fan-out read Postgres on every use, so a missed notification cannot leave a stale sender or recipient.
2. The authenticator cache has a 5-second TTL, so a missed notification leaves a suspended human authenticated for at most 5 seconds.
3. The stream server runs the liveness check on every live socket once per minute, so a missed notification leaves an open socket for at most a minute. A stream upgrade runs it at the moment of upgrade.

`createStreamServer` gains `revalidate({ humanId, endpointId })`, which runs the liveness check on that human's or endpoint's browser and bearer sockets and closes each failure with 1008, and (for the login spec) `closeSession(session_id, code)`. Today it has `notify`, `notifyRoom`, `notifyReceipt`, `notifyResend`, `notifySequenceReset`, and a whole-server `close` (`stream-server.mjs:87-110`).

### Human provisioning

`provisionHumanTx(client, { displayName, displaySource, verification })` runs on a caller-supplied transaction client and returns `{ human_id, endpoint_id, key_id }`. Callers own the transaction. The `pg_notify` goes inside the transaction (see "Reaching the running relay"), so it is delivered only if the commit succeeds. The CLI's `human add` is the simplest caller.

Rows written, with every NOT NULL column populated:

1. `humans(human_id, status='active', created_at)`. `human_id` is `hum_` + 128 random bits, hex.
2. `endpoints(endpoint_id, owner_id=human_id, runtime='human', kind='human', installation_id='install_' + endpoint_id, display_name=<name or endpoint_id>, status='active', created_at)`. `endpoint_id` is `ep_` + 128 random bits, hex, relay-generated. The display name is a label and never an identifier.
3. `endpoint_keys(...)` with the new Ed25519 public key, `algorithm = 'Ed25519'`, status `active`, `valid_from` = now (NOT NULL in `001_initial.sql:39`), no `valid_until`. `key_id` is relay-generated.
4. `human_signing_keys(key_id PK REFERENCES endpoint_keys, wrapped_private_key, created_at)`.
5. `human_attributes` with every NOT NULL column of the table in `003_plugin_connector_auth.sql` populated (`attribute_id` random, kind `name`, value as UTF-8 bytes, observed and created times set). `source` and `verification_state` come from the caller. `verification_state` is constrained to `unverified | provider_verified | challenge_verified | manually_verified | stale | revoked` (`003_plugin_connector_auth.sql:36-37`), and no migration here widens it. The operator CLI passes `source = 'operator'`. The login flow passes `source = <provider name>`. Both pass `unverified`: a display name a provider supplies is a claim and proves nothing, and `source` alone records that it did not come from the operator. When both an operator-chosen name (an invite's `name`) and a provider-supplied name exist, the operator-chosen name is written first and the provider name is written as a second `human_attributes` row; rooms show the operator-chosen name. When no name is supplied the fallback is the endpoint id.
6. An audit event `human.provisioned`.

**Key wrap.** The wrapped plaintext is the Ed25519 private key as PKCS8 DER, the same material the operator identity file holds as PEM (`identity.mjs`). The round-trip test pins that format, so a raw-seed wrap cannot slip through and surface as `KEY_MISMATCH` at the first guest post. AES-256-GCM with a random 96-bit IV per wrap. AAD is `endpoint_id + "\0" + key_id`. `wrapped_private_key` is laid out as `iv (12) || tag (16) || ciphertext`. The wrap key is 32 random bytes, base64-encoded, from `--room-key-wrap-key <ref>` (environment or Doppler, never argv). Any other length is rejected at startup. Provisioning fails with `WRAP_KEY_UNAVAILABLE` when the key is absent. There is no keyring or `wrap_key_id` until key rotation is designed.

Every CLI command that provisions (`human add`) runs in its own process, so it takes the same `--room-key-wrap-key <ref>` flag and reads the same reference. A relay and a CLI configured with different keys produce rows the relay cannot unwrap, and the failure surfaces at the guest's first post, so the operator documentation says to use one reference for both.

Provisioning needs Postgres. The memory repository returns `PROVISIONING_UNAVAILABLE`.

**Credentials for a provisioned human.** `human add` writes no bearer token. Bearer hashes come only from `registry.json`, and rows in `endpoint_tokens` are read by no authenticator. A provisioned human's only way in is the login spec's cookie session. This spec therefore tests the HTTP and socket behavior of a provisioned human at the handler level: the test constructs the principal an authenticator would yield (`{ endpoint_id, owner_id, human_id }`) and calls the route handlers and stream server directly. The full browser path, including a real credential, is tested end to end in the login spec. A provisioned human with no way to log in until the login spec ships is intended.

### Room membership for provisioned humans

`addHumanToRoomsTx(client, { endpointId, memberships, actorHumanId })` takes `memberships` as a list of `{ roomId, role }` and writes one `conversation_members` row per entry, each role `member` or `room_manager`. `invokable_by` keeps its column default and is ignored for human members. `actorHumanId` fills `added_by` (`NOT NULL REFERENCES humans`, `001_initial.sql:56`) and identifies who must be a manager.

- **Actor check.** The actor must hold a manager role in every listed room through one of their endpoints. `lockManagerRows(client, humanId, roomIds)` does the check and the lock in one statement on `client`:
  `SELECT m.* FROM conversation_members m JOIN endpoints e ON e.endpoint_id = m.endpoint_id WHERE e.owner_id = $1 AND m.conversation_id = ANY($2) AND m.removed_at IS NULL ORDER BY m.conversation_id, m.endpoint_id FOR UPDATE OF m`.
  The operator's agents are members too, so one room returns several rows, and the `endpoint_id` tie-break makes the lock order total. Two transactions that name overlapping rooms in different orders therefore cannot deadlock (Postgres would abort one with `40P01`). The helper takes all room ids at once, so the order is the query's and never the caller's. Every multi-room caller (`addHumanToRoomsTx`, `human add --room a --room b`, `add-to-room`, and the login spec's linking transaction) calls it once before its first write and then writes in ascending `roomId` order. A single-room helper called in a loop would lock in argument order and lose the guarantee. A concurrent removal cannot slip between the check and the write. A human with several endpoints qualifies through any one of them that holds a manager role.
- **Target check.** The target endpoint is verified with `lookupTrustedEndpoint(endpointId, client)` on the transaction's client. `provisionHumanTx` inserted it earlier in the same uncommitted transaction, so a lookup on a pool connection cannot see it.
- **Re-adding.** Membership is keyed by `(conversation_id, endpoint_id)`, and removal sets `removed_at` (`postgres-repository.mjs:1740-1747`). The write uses the same upsert as `addRoomMember`: `ON CONFLICT DO UPDATE ... WHERE removed_at IS NOT NULL`, so a removed guest can be restored and an active member is left unchanged. The existing helper throws `ROOM_MEMBER_EXISTS` for an active member; `addHumanToRoomsTx` catches it and treats it as a no-op. A restore also resets `invokable_by` to `'owner'` (add it to the `DO UPDATE SET` list, in the memory repository too), so removing and re-adding a `members` agent never restores a grant the operator did not re-issue.

Existing `addRoomMember` requires the added endpoint to be owned by the caller and present in the registry. The operator path uses the checks above instead.

### Signing seam

`signForEndpoint(endpointId)` becomes async.

- The operator's endpoint still signs with the identity file.
- Any other endpoint loads `human_signing_keys` by its single `active` key_id (the partial unique index above), unwraps with the configured key, derives the public key, and compares it to the `endpoint_keys` row once per process per key. A mismatch throws `KEY_MISMATCH`.
- An endpoint with no key throws `NO_SIGNING_KEY`.

In `room-routes.mjs`, delete the `principal.endpoint_id !== humanSigner.endpointId` guard. A relay started without `--room-human-identity` still has no signer: the route returns a distinct 503 `NO_OPERATOR_IDENTITY` for that case, and does not call `signForEndpoint` on `null` (a TypeError there would be reported as 503 `DATABASE_UNAVAILABLE` by the catch at `http-server.mjs:447-451`). With a signer configured, `await signer.signForEndpoint(principal.endpoint_id)` is the only gate. `--public-origin` requires `--room-human-identity`, since without an operator there is nobody to create rooms or invites. Envelope-layer 401s on this route (`UNKNOWN_ENDPOINT`, `INVALID_SIGNATURE`) are server faults and map to 500, so a web client does not read them as a lost session.

The 4a startup check runs for the operator identity only. Provisioned keys are checked lazily as above, so provisioning a human never makes the relay refuse to start.

### Principal shape

Every credential type yields `{ endpoint_id, owner_id, human_id? }`. `human_id` is present only for human endpoints. Agent credentials never receive it. `ws-ticket` reads `owner_id` (`room-routes.mjs:68`), so any new credential type must supply it.

### Agent invocation policy

`conversation_members` gains `invokable_by TEXT NOT NULL DEFAULT 'owner' CHECK (invokable_by IN ('owner', 'members'))`. It applies to agent members and is ignored for humans (every row carries the default). Every member query returns it.

`room_invocations` gains `subject_human_id TEXT NOT NULL REFERENCES humans(human_id)`: the human whose authority the invocation runs under. Every row is written with it: mention, assignee, router, and the queued rows that `promoteNextInvocation` promotes later.

`mayInvoke(subjectHumanId, targetAgent)` is the single check:
- `owner`: allowed only when `subjectHumanId` equals the agent endpoint's `owner_id`.
- `members`: allowed for any human member of the room.

**Who is the subject.**
- Human message with `mentions`, a `task.request` assignee, or a router route: the message's sender. The invocation row records it as `subject_human_id`.
- Router-selected invocation: the router is an agent, so its `owner_id` is not the subject. `POST /v1/rooms/{id}/invocations` loads the trigger envelope, requires its sender to be a human member, and applies `mayInvoke` to that human for each selected agent before `dispatchToTarget`. The web client never sends `mentions`, so unmentioned composer messages always take this path, and it is the path tests must cover. (`joins` agents run only through the router, `room-dispatch.mjs:115-128` and `room-routes.mjs:308`, so "joins routing" is this path and not a separate one.)
- Agent-authored trigger (an agent mentions or assigns another agent): the subject is **not** the sending agent's owner. `assertAgentMayPost` already returns the invocation the agent is completing (`completing`). The new invocation inherits that invocation's `subject_human_id` unchanged, and `mayInvoke(subject, target)` runs against it. The subject therefore survives every hop. Using the sending agent's owner would let a guest reach any owner-only agent: the guest invokes a `members` agent, steers its reply to `@mention` an owner-only agent of the same owner, and the check passes against the operator. An agent cannot trigger a target that the human who started the chain could not.

**Cost and budget outside `mayInvoke`.**
- `applyRoomDispatch` delivers every unmentioned human message to the room's router members when a `joins` agent is active. A router member is an invocation target: the router delivery is gated by `mayInvoke` for the sender, and `hasJoinedAgent` counts only `joins` agents the sender may invoke. A guest who may invoke none costs the operator no model call.
- `applyRoomDispatch` resets `room_threads.agent_turns` for any non-agent sender (`room-dispatch.mjs:81`). The reset applies only when the posting human is the `subject_human_id` of the invocations active in that thread, so a guest cannot refill an operator-owned chain's `max_agent_turns` by posting in its thread.
- `room_invocations.decided_by` already allows `'assignee'`: `032_room_task_assignee.sql` widened the CHECK to `('mention', 'router', 'assignee')`. This migration does not touch it.
- **Authority is re-checked when a queued row starts.** `promoteNextInvocation` today checks only `deliveryBlocker` before it starts a queued invocation. Inside the promotion transaction it also requires that the `subject_human_id` human is `active`, is still an active member of the room, and still passes `mayInvoke` against the agent's current `invokable_by` and owner. A row that fails is marked `refused`, with the same event and `room.invocation_refused` audit row as any refusal, and the next queued row is considered. Otherwise a guest queues work behind a busy agent, the owner switches the agent to `owner`, removes the guest, or suspends them, and the model call runs anyway.
- **Suspension and removal cancel in-flight work.** Suspending a human, or removing them from a room, cancels the queued and running invocations whose `subject_human_id` is that human (in that room, for a removal), the way `stop` does. Without it a guest's running chain keeps passing between `members` agents with the guest as subject, limited only by `max_agent_turns`.

A refused trigger posts a `room.event` ("not allowed to invoke <agent>") and writes `room.invocation_refused`. It never silently drops. A router decision naming a disallowed agent is filtered before dispatch.

**Residual risk, stated.** `mayInvoke` governs who starts an invocation. It does not govern what an invoked agent reads. One CLI session serves a room, and an agent reads the thread context (`room-bridge.mjs:49-58`, `:95-101`), so a guest who posts into a thread where the operator's agents are running puts text in front of them without invoking them. A `members` grant also lets a guest ask that agent about anything in the session. The grant is therefore a per-agent decision the operator makes knowingly, and the documentation says so. A guest also sees the room's full history from sequence 0, including messages from before they joined (`room-routes.mjs:254-262`).

**Setting it.** `sigil relay agent set-invokable --room <id> --agent <endpoint_id> --mode owner|members` and `POST /v1/rooms/{id}/members/{endpoint_id}/invokable-by` with `{ invokable_by }`. It is a POST beside `response-mode`, since every rooms mutation is a POST and CORS allows `GET, POST, OPTIONS` only (`browser-cors.mjs:21`). Only the agent's owner may change it, and a `room_manager` guest cannot. The roster hides the mode controls from anyone who does not own the agent.

The bridge preamble (`sigil/bridges/v1/room-bridge.mjs`) says "only the human room owner can change your task" without naming the owner. `listRoomMembers` returns no `owner_id`, so it is extended to return it, and the preamble names the agent's owner endpoint id. In `members` mode that line is rewritten to say that any room human who passes the policy may task the agent.

**Other room controls.**
- `response-mode` change and agent removal require that the target agent is owned by the caller, not only a manager role. This is a deliberate change from the parent design, which says "Room managers manage the roster and the response modes" (`2026-10-02-sigil-rooms-design.md:39`) in the same paragraph as "being a room manager grants no control over an agent endpoint's configuration". A guest who set an agent to `router` mode would make it receive every message.
- `POST /v1/rooms/{id}/stop` cancels invocations only for agents the caller owns, and also invocations whose `subject_human_id` is the caller, so a guest can stop an agent they started. The operator therefore stops everything of theirs, and a guest stops nothing of the operator's that the operator started.
- `POST /v1/rooms` (create room) is allowed only for the operator's endpoint. A guest who created a room would become its `owner`, outside the intended guest roles.

**Who is the operator.** The operator is a human: the human that owns the `--room-human-identity` endpoint. Rules that compare humans (`mayInvoke`, `stop`) and rules that compare endpoints (room creation, `is_operator`) all resolve through `endpoints.owner_id`, so a human who owns two endpoints gets the same answer on every route.

### Suspension

`sigil relay human suspend <human_id>` runs one transaction that:
1. Sets `humans.status='suspended'`. This is the first write, and a returning login takes `FOR SHARE` on that row (login spec), so a login in flight either commits its session before the session sweep in step 3 (and is revoked by it) or reads `suspended`.
2. Sets `endpoints.status='suspended'` for that human's endpoints that are currently `active`, and records them with `endpoints.suspended_by_human_id = <human_id>`. Endpoints already `suspended`, `revoked`, `decommissioned`, or `pending` are left alone.
3. Revokes that human's `human_sessions`.
4. Writes `human.suspended` and calls `pg_notify`.

`unsuspend` sets `humans.status='active'` and flips back only the endpoints whose `suspended_by_human_id` is that human and whose status is still `suspended`, clearing the column. An endpoint that was revoked or suspended for another reason stays as it is. It does not restore revoked sessions.

Suspending the endpoints matters: `endpointIsActive` and `lookupRecipientEndpoint` read `endpoints.status` and an active `endpoint_keys` row, and without it a suspended guest keeps receiving deliveries that count against `inboxDepthLimit`. A suspended member is absent from fan-out, and a test pins that. The `?? registered.get(...)` fallback in `endpointIsActive` is gone (see "Call sites"), so a stale Map entry cannot outvote the suspended row.

Every authenticator re-checks `humans.status` and endpoint status per request through a 5-second in-process cache, cleared by `NOTIFY`. A suspended human gets 401. The notification expands the human to all owned endpoints and revalidates all their sockets, which closes them.

## Data

One migration, numbered 033 on this checkout (the highest existing is `032_room_task_assignee.sql`), or the next free number on `main` at merge:

- `endpoints.kind TEXT NOT NULL CHECK (kind IN ('human','agent','system'))`. The migration adds the column nullable, runs the backfill above, then sets `NOT NULL`, because the column has no default and existing rows would fail a direct `ADD COLUMN ... NOT NULL`.
- `endpoints.suspended_by_human_id TEXT NULL REFERENCES humans(human_id)`.
- `endpoint_keys`: a partial unique index on `(endpoint_id) WHERE status = 'active'`, created after the surplus-key handling in "One signing key".
- `human_signing_keys(key_id TEXT PRIMARY KEY REFERENCES endpoint_keys(key_id), wrapped_private_key BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL)`. `endpoint_keys.key_id` is already `TEXT PRIMARY KEY` (`001_initial.sql:34`), so the reference is a single column.
- `conversation_members.invokable_by` as above.
- `room_invocations.subject_human_id` as above. Existing rows have no subject, so the migration adds the column nullable, backfills it from `envelopes.sender_owner_id` joined on `trigger_message_id = envelopes.message_id` (for a pre-existing agent-authored trigger this is the sending agent's owner, which is the only authority those rows ran under), then sets `NOT NULL`. A row with no matching envelope fails the migration with a message naming its `invocation_id`.

## CLI

All commands that provision or sign take `--room-key-wrap-key <ref>`. Commands that act as the operator take `--identity <path>` (the `--room-human-identity` file), because a separate process cannot read the relay's configuration.

- `sigil relay human add --name <name> [--room <id>:<role> ...]`.
- `sigil relay human add-to-room --human <human_id> --room <id>:<role>`. It resolves the human's endpoint, then calls `addHumanToRoomsTx` with the operator as `actorHumanId`, in its own transaction, with the manager check above, and notifies with the room id. Re-adding a removed member restores them.
- `sigil relay human suspend|unsuspend <human_id>`.
- `sigil relay agent set-invokable --room <id> --agent <endpoint_id> --mode owner|members`.
- `sigil relay endpoint revoke <endpoint_id>`.
- `sigil relay up` documents `--room-key-wrap-key`, `--reconcile-kind`, and that `--public-origin` requires `--room-human-identity`.

## Testing

Tests that use HTTP or sockets as a provisioned human run at the handler level (see "Credentials for a provisioned human"). All of these run against Postgres, because the e2e harness's memory mode shares and mutates the registry Map and would hide the failure:

- A provisioned human posts a room message and the verified sender is their endpoint. Repeat after a relay restart. Two provisioned humans produce two distinct verified senders.
- `kind`: an agent bearer token authenticates without `human_id`, and cannot create rooms, add members, or post as a human. A `relay`, `federated`, or unknown-runtime row never gets `human_id`. A `system` endpoint never receives `human_id`. A legacy file row with no `kind` fails startup with `REGISTRY_CONFLICT` (naming both values) until `--reconcile-kind <endpoint_id>=<kind>` for that endpoint, then has that `kind`. `ensureRoomSystemEndpoint` and `registerFederatedSender` succeed against an `endpoints.kind NOT NULL` schema.
- Seed: a revoked endpoint stays revoked after restart. A file row with `status: "revoked"` revokes a Postgres row. A file row conflicting with Postgres on `owner_id`, `kind`, or key fails startup with `REGISTRY_CONFLICT`.
- Federated rows: a shadow sender written by `registerFederatedSender` is not returned by `lookupTrustedEndpoint`, and its envelope is rejected on `POST /v1/envelopes`.
- Multi-key endpoint: a retiring key still verifies inside its window, a retiring key is rejected after `valid_until`, a future-dated key is rejected before `valid_from`, a `retired` key never verifies (including one with a null `valid_until`), and verification selects by `key_id`. `forwardEnvelope` advertises the key that matches `signature.key_id`. A second `active` key on one local endpoint is rejected by the unique index. A federated sender that presents a second `key_id` is accepted: `registerFederatedSender` retires the first shadow key, and the migration retires surplus shadow keys instead of failing. `forwardEnvelope` refuses to forward for a revoked endpoint and for a retired key.
- Cross-process: `human add` and `suspend` run from a second CLI process against a live relay and a live stream socket. The authenticator cache clears, and every socket of every endpoint of that human closes with 1008. A dropped listener connection recovers on reconnect. A relay that misses a notification authenticates a suspended human for at most the 5-second cache TTL, and verifies signatures and fans out against current Postgres state regardless.
- `endpoint revoke` on an agent with an open bearer stream socket and a cached authenticator entry closes the socket and rejects the next request without waiting for the cache TTL. Every CLI `pg_notify` payload stays under 8000 bytes however much data the command touches, and a failed `notifyRoomHumans` read is a test failure on Postgres, not a log line.
- Transaction composition: a failure after `provisionHumanTx` inside an outer transaction leaves no human, endpoint, or key, and no notification is delivered. `addHumanToRoomsTx` finds an endpoint created earlier in the same transaction. Two concurrent transactions naming overlapping rooms in opposite order do not deadlock.
- Wrap: round trip with PKCS8 DER, wrong key, swapped ciphertext between two endpoints (AAD rejects), missing key at provisioning.
- `invokable_by` and `subject_human_id`: an owner-only agent mentioned by a guest is refused with an event and an audit row. The same through the router (an unmentioned composer message the router answers) and `task.request`. **A `members` agent invoked by a guest cannot hand off to an owner-only agent**: the `@mention` in its reply is refused, because the new invocation inherits the guest as subject. A `members` agent accepts the guest. A guest `room_manager` cannot change a mode, remove an agent, or call `set-invokable`. A guest who may invoke no `joins` agent triggers no router delivery. A guest posting into a thread does not reset an operator-started chain's `agent_turns`. A `task.request` assignee dispatch inserts without violating `decided_by`.
- Guest `stop` cancels none of the operator's invocations, and does cancel an invocation the guest started. Guest `POST /v1/rooms` returns 403.
- Authority withdrawal: a queued invocation whose subject is suspended, removed from the room, or whose agent is switched to `owner` after queueing is marked `refused` at promotion and runs no model call. Suspending a human cancels their queued and running invocations.
- Suspension: 401 on the next request, sockets closed, sessions revoked, fan-out skips the endpoint, unsuspend restores access. A human with two endpoints has both suspended and both closed. An endpoint revoked before the suspension stays revoked after unsuspend. An endpoint suspended independently stays suspended.
- A relay without `--room-human-identity` returns 503 `NO_OPERATOR_IDENTITY` on a room post, not a TypeError.
- A provisioned human receives room messages (the `endpoint_keys` row exists).

## Out of scope

- Any login method, cookie, or invite. See the login spec.
- Browser-held signing keys and wrap-key rotation.
- Memory-repository support for provisioning.
- Per-room roles beyond `member` and `room_manager` for guests.
