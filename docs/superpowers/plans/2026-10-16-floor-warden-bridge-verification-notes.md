# Floor Warden bridge verification notes

These notes settle spec assumptions 5 and 6. Paths are relative to the worktree root.

## Token loading (assumption 5)

A bearer token added to the registry file after startup is not honored until the relay restarts.

- `sigil/cli/sigil.mjs:262-263` reads the registry file once and builds `tokenHashes` with `toTokenHashes(data)`.
- `sigil/cli/sigil.mjs:338` passes that map to `createBearerAuthenticator`.
- `sigil/relay/v1/transport-auth.mjs:22` copies the map into a private `hashes` Map; `:30` looks tokens up there only.
- `clearAll()` (`transport-auth.mjs:79-82`, driven by `onReconnect` at `sigil/cli/sigil.mjs:373`) clears only the liveness cache, not `hashes`.
- Nothing re-reads the registry file while the relay runs.

`sigil/cli/registry-seed.mjs` needs no private key. It reads only `public_key_pem` (`:47`, `:53`). An entry without `public_key_pem` still gets its `humans` and `endpoints` rows, and the key insert and comparison are skipped. It never reads `relay_token`.

`toTokenHashes` (`sigil/cli/registry-store.mjs:47-49`) hashes `e.relay_token` for every entry, so every registry entry needs a `relay_token`.

Task 5 prints this line after `bot add`: "restart relay after `bot add` so it loads the new token".

## Daemon ack rule (assumption 6)

The room branch is `sigil/cli/agent-daemon.mjs:213-226`.

- If `onRoomMessage` returns, the daemon acks the delivery with `outcome: 'acknowledged'` (`:224`). It returns `room_<outcome>`, and the `?? 'failed'` fallback covers a missing `outcome`. The bridge's `forwarded`, `failed` and `skipped` are all acked.
- If `onRoomMessage` throws, the daemon logs the error, skips the ack and returns `room_unacked` (`:218-222`). `poll` records this as `leftUnacked` (`:242`), and the delivery returns on the next poll.

The bridge must never throw once it knows the invocation. It must throw only when it cannot look the invocation up.

## `identityKeys` callers (Task 11)

`identityKeys` (`sigil/cli/identity.mjs:30-35`) calls `crypto.createPrivateKey(identity.private_key_pem)`. It throws for an identity with no `private_key_pem`, even for callers that need only the public key.

Production callers (tests excluded), 14 in all:

- `sigil/cli/agent-daemon.mjs:53` (eager, at daemon start; Task 11 makes it lazy)
- `sigil/cli/agentmail-provision.mjs:15`
- `sigil/cli/doctor.mjs:57`
- `sigil/cli/memory-repository.mjs:246`
- `sigil/cli/sigil.mjs:615`, `:652`, `:1033`, `:1106`
- `sigil/connectors/v1/mcp-stdio-server.mjs:71`
- `sigil/relay/v1/postgres-repository.mjs:546`
- `sigil/relay/v1/room-events.mjs:27`
- `sigil/relay/v1/room-human-signer.mjs:13`
- `sigil/scripts/live-room-bridges.mjs:27`
- `sigil/scripts/live-room-router.mjs:44`

The brief's grep for `identityKeys(identity)` matches all 14 calls plus the definition. Only `sigil/cli/agent-daemon.mjs:53` runs for a keyless Floor Warden identity.
