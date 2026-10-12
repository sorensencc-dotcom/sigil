# Foundation call-site inventory

Generated 2026-10-12 on branch `docs/sigil-rooms-third-party-login-spec`. Tasks 3-5 and 11-12 close out the rows they own.

Greps (run from the worktree root):

```bash
grep -rnE "registry(\.|\?\.)(get|set|has)\b|registered(\.|\?\.)(get|set|has)\b|instanceof Map" sigil --include=*.mjs | grep -v node_modules   # 43 hits
grep -rn "INSERT INTO endpoints" sigil --include=*.mjs --include=*.sql | grep -v node_modules                                                # 45 hits
```

Owner `n/a` marks a hit that matches the pattern but is not an endpoint-registry consumer. Owner `Tn-own` means the test exercises a production site owned by task Tn and updates with it.

## Map consumer

### Production

| file:line | Kind | Owner |
|---|---|---|
| sigil/relay/v1/validate-envelope.mjs:72 | `registered.get(sender)` | T3 |
| sigil/relay/v1/validate-envelope.mjs:96 | `endpoint.keys instanceof Map` (key set) | T3 |
| sigil/relay/v1/accept-envelope.mjs:303 | `options.registered?.get(recipientId)` | T4 |
| sigil/relay/v1/accept-envelope.mjs:373 | `options.registered?.get(recipient)` owner lookup | T4 |
| sigil/relay/v1/accept-envelope.mjs:374 | `options.registered?.get(sender)` owner lookup | T4 |
| sigil/relay/v1/accept-envelope.mjs:496 | `forwardEnvelope` `registered.get(sender)` (brief range 496-507) | T4 |
| sigil/relay/v1/accept-federated-envelope.mjs:150-155 | Builds `registered` Map literal (brief-listed; not matched by grep) | T4 |
| sigil/relay/v1/accept-federated-envelope.mjs:196 | `registered?.get(recipientId)` | T4 |
| sigil/relay/v1/transport-libp2p/p2p-data-protocol.mjs:76 | `registered?.get(sender)` (brief range 76-79) | T4 |
| sigil/ingress/v1/agentmail-adapter.mjs:160 | `registry instanceof Map ? registry.get(...)` | T4 |
| sigil/ingress/v1/agentmail-adapter.mjs:162 | `registry instanceof Map && !registeredEndpoint` | T4 |
| sigil/relay/v1/room-policy.mjs:80 | `registered?.get?.(member.endpoint_id)` | T4 |
| sigil/relay/v1/room-policy.mjs:92 | `registered?.get(endpointId)` fallback | T4 |
| sigil/relay/v1/room-policy.mjs:93 | `registered?.get(endpointId)` | T4 |
| sigil/relay/v1/room-routes.mjs:50 | `registry?.get?.(principal.endpoint_id)?.kind` | T4 |
| sigil/relay/v1/room-routes.mjs:191 | `registry?.get?.(endpointId)` | T4 |
| sigil/relay/v1/room-human-signer.mjs:11 | `registry?.get?.(identity.endpoint_id)` | T11 |
| sigil/relay/v1/transport-auth.mjs:27 | `registry?.get(endpointId)` | T5 |
| sigil/relay/v1/transport-auth.mjs:17 | `tokenHashes instanceof Map` (token hashes, not registry) | n/a |
| sigil/cli/sigil.mjs:237-264 | `sigil relay up` loads registry file and builds Map (brief-listed; grep matched no line) | T6, T12 |
| sigil/cli/sigil.mjs:327 | Registry wiring into relay (brief-listed; grep matched no line) | T6, T12 |
| sigil/cli/memory-repository.mjs:228 | in-memory `registry.get(endpointId)` | T6 |
| sigil/cli/memory-repository.mjs:233 | `registry.get(identity.endpoint_id)` | T6 |
| sigil/cli/memory-repository.mjs:243 | `registry.set(identity.endpoint_id, ...)` | T6 |
| sigil/cli/memory-repository.mjs:255 | `registry.has(endpoint_id)` | T6 |
| sigil/cli/memory-repository.mjs:256 | `registry.set(endpoint_id, ...)` | T6 |
| sigil/connectors/v1/plugin-manifest.mjs:30 | `publisherKeys instanceof Map` | n/a |
| sigil/ingress/v1/agentmail-adapter.mjs:61 | `tokenStore instanceof Map` | n/a |
| sigil/relay/v1/approval-ceremony.mjs:24 | CBOR `root instanceof Map` | n/a |
| sigil/relay/v1/approval-ceremony.mjs:35 | CBOR `attStmt instanceof Map` | n/a |
| sigil/relay/v1/approval-ceremony.mjs:62 | CBOR `coseKey instanceof Map` | n/a |

### Test

| file:line | Kind | Owner |
|---|---|---|
| sigil/integration/vertical-slice.test.mjs:82 | `registry.get(endpointId)` | T4-own |
| sigil/relay/v1/accept-envelope.rooms.pg.test.mjs:94 | `world.registered.get(sender).public_key` | T4-own |
| sigil/relay/v1/accept-envelope.rooms.test.mjs:171 | `registered.get('ep_web2').status = 'revoked'` | T4-own |
| sigil/relay/v1/federation-regression.test.mjs:156 | `world.registered.set(...)` | T4-own |
| sigil/relay/v1/federation-regression.test.mjs:160 | `world.registered.get(...)` x2 | T4-own |
| sigil/relay/v1/room-dispatch.test.mjs:160 | `w.registered.get('ep_claude').status` | T4-own |
| sigil/relay/v1/room-dispatch.test.mjs:406 | `w.registered.get('ep_router').status` | T4-own |
| sigil/relay/v1/room-dispatch.test.mjs:421 | `w.registered.get('ep_claude').status` | T4-own |
| sigil/relay/v1/room-routes.test.mjs:267 | `registry.get('ep_claude').status` | T4-own |
| sigil/relay/v1/room-routes.test.mjs:277 | `registry.get('ep_claude').status` | T4-own |
| sigil/relay/v1/room-send-route.test.mjs:75 | `w.registry.get('ep_web').public_key` | T4-own |
| sigil/relay/v1/room-system-identity.test.mjs:36 | `registry.get('ep_relay_system')` | T4-own |
| sigil/relay/v1/room-updated.integration.test.mjs:92 | `w.registered.set('ep_web3', ...)` | T4-own |
| sigil/relay/v1/room-updated.integration.test.mjs:130 | `w.registered.set('ep_router', ...)` | T4-own |
| sigil/relay/v1/room-updated.integration.test.mjs:168 | `w.registered.set(id.endpoint_id, ...)` | T4-own |

## INSERT INTO endpoints

### Production

| file:line | Kind | Owner |
|---|---|---|
| sigil/relay/v1/postgres-repository.mjs:480 | register endpoint (default `active`) | T5 |
| sigil/relay/v1/postgres-repository.mjs:494 | endpoint insert (second form) | T5 |
| sigil/relay/v1/postgres-repository.mjs:825 | endpoint insert with `origin_domain` | T5 |
| sigil/cli/sigil.mjs:261 | CLI endpoint seed | T5 |

### Test fixtures (owner T5)

| file:line |
|---|
| sigil/cli/sigil-relay-postgres-startup.integration.test.mjs:76 |
| sigil/integration/vertical-slice.test.mjs:45 |
| sigil/migrations/003_plugin_connector_auth.test.mjs:26 |
| sigil/relay/v1/accept-envelope.rooms.pg.test.mjs:28 |
| sigil/relay/v1/accept-federated-envelope.pg.test.mjs:60 |
| sigil/relay/v1/accept-federated-envelope.pg.test.mjs:169 |
| sigil/relay/v1/accept-federated-envelope.pg.test.mjs:260 |
| sigil/relay/v1/idempotency-race.pg.test.mjs:33 |
| sigil/relay/v1/identity-auth-audit-atomicity.test.mjs:28 |
| sigil/relay/v1/identity-auth-repository.integration.test.mjs:28 |
| sigil/relay/v1/postgres-mock-oidc-route.test.mjs:29 |
| sigil/relay/v1/postgres-mock-oidc-route.test.mjs:55 |
| sigil/relay/v1/postgres-real-oidc-route.test.mjs:57 |
| sigil/relay/v1/postgres-repository.directory-invites.test.mjs:27 |
| sigil/relay/v1/postgres-repository.directory-links.test.mjs:27 |
| sigil/relay/v1/postgres-repository.directory-links.test.mjs:96 |
| sigil/relay/v1/postgres-repository.directory-match.test.mjs:27 |
| sigil/relay/v1/postgres-repository.integration.test.mjs:33, 133, 187, 249, 315, 389, 451, 489, 525, 560, 592 |
| sigil/relay/v1/postgres-repository.stream-sequence.test.mjs:30 |
| sigil/relay/v1/postgres-repository.transaction-participation.test.mjs:54 |
| sigil/relay/v1/receipts.pg.test.mjs:16 |
| sigil/relay/v1/room-ack.pg.test.mjs:22 |
| sigil/relay/v1/room-events.pg.test.mjs:49 |
| sigil/relay/v1/room-history-event-rows.test.mjs:59 |
| sigil/relay/v1/room-invocations-route.pg.test.mjs:51 |
| sigil/relay/v1/room-invocations.pg.test.mjs:28 |
| sigil/relay/v1/room-send-route.pg.test.mjs:40 |
| sigil/relay/v1/room-stop-concurrency.pg.test.mjs:52 |
| sigil/relay/v1/room-system-identity.pg.test.mjs:79 |
| sigil/relay/v1/rooms-manage.pg.test.mjs:16 |
| sigil/relay/v1/rooms.pg.test.mjs:16 |

Totals: 45 grep hits (4 production, 41 test; postgres-repository.integration.test.mjs holds 11). No `.sql` migration contains `INSERT INTO endpoints`.
