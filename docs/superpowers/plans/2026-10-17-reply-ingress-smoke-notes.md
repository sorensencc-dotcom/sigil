# Reply ingress live transport smoke notes

These notes record the Task 15 live transport smoke of the Phase 7 reply ingress. The run proves transport only. One result differs from the plan (the per-bot rate limit). It is a product bug, listed under [Open findings](#open-findings).

All times are America/New_York on 2026-10-20. This file names the origin only as "the approved origin". It contains no hostname, token, header value, account ID, or secret.

## Verdict

- Transport works end to end. Requests from outside the LAN reach the relay through Cloudflare's edge, Cloudflare Access, and the tunnel.
- Ten of eleven cases matched the expected result. The burst case did not. The per-bot limit of 30 requests per minute is never enforced (finding 1).
- `sigil ingress doctor` passed every check.
- The proof bar is not met. It needs a real Grok reply that lands in a room, then 7 days with no incidents.

## Approval

Chris approved the Task 15 provider setup in writing on 2026-10-20 at 6:09 PM ET. First Mate relayed the approval and saw it directly.

## Provider setup

Chris did the provider setup in the Cloudflare dashboard. This run did not do it.

- **Tunnel.** A remotely managed Cloudflare Tunnel named `sigil-reply-ingress`, with one published route to `http://127.0.0.1:8796` and a proxied tunnel DNS record.
- **Access.** A Cloudflare Access self-hosted application named `sigil-reply-ingress`, with one Service Auth policy. The policy includes only the service token `sigil-reply-ingress-smoke`.
- **Connector.** The tunnel connector runs as the Windows service `Cloudflared` (startup type Automatic) on Chris's PC. This run did not start, stop, or change it. Running `cloudflared` as a service is an owner-Chris follow-up already listed in the runbook.

## Fixture

- **Database.** The disposable Postgres database `sigil_test`, in the container `sigil-pg-test`, bound to `127.0.0.1`. The run reset it with migrations and applied 38, through 039.
- **Bots.** The fixture bot `bot_test` with endpoint `ep_test_bot`. A second fixture bot, `bot_other` with endpoint `ep_other`, serves the wrong-bot case.
- **Room and invocation.** A disposable room and a running invocation.
- **Smoke token.** Created with `sigil bot token create`. It lived only in a process environment variable. The run never wrote it to a file or a log.
- **Real systems.** The run used no real bots, endpoints, database, or Grok routine.

## Relay

The run started the relay with `sigil relay up` against `sigil_test`, with `--ingress-port 8796`, `--ingress-origin` set to the approved origin, and explicit free relay, stream, and public ports.

Startup printed the reply ingress origin line and `Reply ingress listener: 127.0.0.1:8796`. It printed no global-token warning, because that flag was off.

## Where the calls ran

- **Request table.** A process on Chris's PC called the public hostname. Traffic left through Cloudflare's edge and returned through the tunnel. The process read the Access headers from environment variables.
- **No-Access-header case.** This case ran from the Linux box, which is outside the LAN.
- **Runs.** Three runs happened, at 22:20, 22:22, and 22:23 ET. Repeated cases matched. The table below is from the 22:23 run.

## Baseline before the relay

Both checks ran at 22:18 ET with nothing listening on 8796 for the relay.

| Call | Result |
|---|---|
| Linux box, no Access headers | `403` (Access) |
| Chris's PC, Access headers, nothing on 8796 | `502` (Cloudflare reports the origin is down) |

## Results

Expected results come from the Task 15 table in the plan. The plan table has seven rows. This run added the rows for the missing bearer, unknown token, other paths, and unknown room.

| Call | Expected | Actual |
|---|---|---|
| No Access headers (Linux box, relay up, 22:21 ET) | Access block | `403` |
| No bearer, Access headers | `401` | `401 UNAUTHENTICATED` |
| Unknown token | `401` | `401 UNAUTHENTICATED` |
| Valid token, running invocation | `202` | `202`, `duplicate: false`. The reply `message_id` appears once each in `envelopes`, `deliveries`, and `idempotency_keys` in `sigil_test`. |
| Same body again | `202` with `duplicate: true` | `202` with `duplicate: true` |
| Valid token for another bot (wrong `target_bot_id`) | `403` | `403 BOT_NOT_ON_ROSTER`. This confirms the PR #88 fix on a live path. |
| Revoked token | `401` | `401 UNAUTHENTICATED`. Revoked with `sigil bot token revoke --bot-id bot_test --token-id <id>`. |
| Burst above the per-bot limit (32 requests in about 3 s, new idempotency keys, sent after the invocation completed) | `429` | **Mismatch.** 32 ├ù `403`, no `429`. |
| `GET /v1/rooms` | `404` | `404` |
| `POST` to any other path | `404` | `404 NOT_FOUND` |
| Unknown room | `404` | `404 ROOM_NOT_FOUND` |

The burst returned `403` rather than `429` because the invocation had already completed. The `403` does not show that the rate limit works. Finding 1 explains why the limit never applies.

## Doctor results

The run used this command, plus explicit ports. The two `--access-client-*-env` flags name environment variables, so no secret appears on the command line.

```
sigil ingress doctor --origin <approved origin> --access-client-id-env SIGIL_ACCESS_CLIENT_ID --access-client-secret-env SIGIL_ACCESS_CLIENT_SECRET
```

| Check | Result |
|---|---|
| Port overlap | none |
| Reply gate | pass |
| Root route | pass |
| Rooms route | pass |
| Certificate | pass |
| Ingress doctor | pass |

## Status

`sigil ingress status` reported the following. Token IDs are omitted.

| Bot | Token | `accepted_last_hour` |
|---|---|---|
| `bot_test` | revoked | 1 |
| `bot_other` | active | 0 |

## Kill switch

At 22:23:53 ET the run stopped the relay and checked the result.

- Port `127.0.0.1:8796` was closed.
- Chris's PC, with Access headers, got `502` (origin down).
- The Linux box, without headers, got `403` at 22:24 ET.

The tunnel, the Access application, and the service token stay configured.

## Secret hygiene

A pattern scan of every response and log found no token, header value, secret, or hostname.

## Open findings

### 1. `relay up` never enforces the per-bot rate limit (product bug)

`sigil/cli/sigil.mjs` calls `createReplyIngress({ gate, repository, ratePerMinute, metrics, logger })` without the `match` token matcher. In `sigil/relay/v1/reply-ingress.mjs`, `tokenMatch` therefore stays `null`. `reserveBot` then receives an undefined `botId` and allows the request. The 30 requests per minute limit per bot never applies under `relay up`.

The unit tests pass `match` directly, so they miss the bug. The 120 requests per minute ingress ceiling is unaffected.

Fix: pass the reply token matcher to `createReplyIngress`, and add a test at the `relay up` level.

### 2. Plan and runbook show an incomplete revoke command

`sigil bot token revoke` needs `--bot-id` as well as `--token-id`. Step 5 of Task 15 in the plan shows only `--token-id`.

Fix: update the plan text and the runbook text.

### 3. The Access client secret is shorter than expected

The Access client secret environment variable holds 54 characters. About 64 are expected. The edge accepted the secret, so it may be complete.

Action: confirm that the full secret was stored.

## Proof bar

The proof bar is not met. It requires two things:

1. A real Grok reply that lands in a room.
2. 7 days with no incidents.

This run proves transport only.
