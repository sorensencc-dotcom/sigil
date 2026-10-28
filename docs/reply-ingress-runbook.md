# Reply ingress runbook

This runbook is for the operator who connects Grok's cloud to the Sigil reply ingress and keeps it running. It is a how-to guide. Follow the sections in order the first time. After that, jump to the section you need.

Every step that this repo's code does not prove is marked "not verified here". That covers every Cloudflare and Tailscale console step, the `cloudflared` and `tailscaled` Windows service steps, and the WAF rule. The repo verifies the Sigil side only: the `sigil relay up` flags, the `sigil bot token` commands, and `sigil ingress status` and `sigil ingress doctor`.

## Purpose

Grok's cloud computers can make outbound HTTPS requests, but they cannot reach `127.0.0.1` on the PC behind NAT. Without a path back, a Grok bot's answer never reaches the room, and the invocation ends in `REPLY_TIMEOUT` after 15 minutes. The design is in `docs/superpowers/specs/2026-10-17-sigil-rooms-phase-7-tunnel-design.md`.

The reply ingress is one loopback listener that serves one route. A tunnel provider makes that listener reachable from the internet without opening an inbound port on the PC.

The setup has three parts.

- **Cloudflare Tunnel with Cloudflare Access.** This is the path for Grok's cloud. A dedicated hostname under `rewritelabs.io` reaches the ingress through the tunnel. A Cloudflare Access application with a Service Auth policy and a service token protects the hostname.
- **Tailscale.** Use it for local and mesh access.
- **Tailscale Funnel.** Use it only as a fallback to unblock the first smoke test. Funnel has no edge auth and no edge rate limit. See [Fall back to Tailscale Funnel](#fall-back-to-tailscale-funnel).

Sources: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/), [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel), [Grok bot security](https://docs.x.ai/grok-bot/security).

## What is exposed

The ingress exposes one route.

```
POST /v1/rooms/{room_id}/replies
```

The listener binds `127.0.0.1` only. The relay listener, the stream listener, and the cookie-only public listener are not exposed. Every other method and path gets one fixed `404` with the code `NOT_FOUND`.

| Item | Value |
|---|---|
| Default ingress port | `8796`, which is the relay port plus 5 at relay port `8791` |
| Override flag | `--ingress-port` |
| Credential | A per-bot reply token. Each token works for one `bot_id`. |
| Global token | Refused unless you pass `--ingress-allow-global-token`. The relay prints a startup warning when you do. |
| Ingress-wide limit | 120 requests per minute for all callers. Override with `--ingress-rate-per-minute`. |
| Per-bot limit | 30 requests per minute for each bot. This is a constant. |
| Limit response | `429 RATE_LIMITED` with `Retry-After: 60` |

The relay refuses to start unless the relay, stream, public, and ingress ports are four distinct values. The ingress also answers `401 UNAUTHENTICATED` for every token that does not match. It never reads `X-Forwarded-For` or any provider identity header.

The 120 requests per minute limit is one shared bucket, so a flood can lock out the real caller. Add the Cloudflare WAF rule below to control floods.

## Set up Cloudflare Tunnel

**Blocking prerequisite.** The `rewritelabs.io` zone is not yet verified or active in Cloudflare. Do not start any step below until the zone shows as active. Without an active zone, Cloudflare cannot route a hostname to the tunnel and cannot apply Access or WAF rules to it. If the zone stays blocked, use [the Funnel fallback](#fall-back-to-tailscale-funnel) for the first smoke test only. Not verified here: the zone's current state.

Pick a dedicated hostname under `rewritelabs.io`. This runbook writes it as `<ingress-hostname>`. Do not reuse a hostname that serves anything else. Do not put the real value in the repo.

Cloudflare Tunnel makes outbound connections to Cloudflare on port 7844 and needs no inbound port on the PC. Access cannot enforce on a non-standard port in the URL, so the public URL must use the default HTTPS port with no port number. Source: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).

1. Create a tunnel and route `<ingress-hostname>` to it in the Cloudflare console or with `cloudflared`. Not verified here.
2. Add one ingress rule from `<ingress-hostname>` to `http://127.0.0.1:8796`. Use your `--ingress-port` value if you changed it. Add a final catch-all rule that returns `http_status:404`. Not verified here.

   ```yaml
   ingress:
     - hostname: <ingress-hostname>
       service: http://127.0.0.1:8796
     - service: http_status:404
   ```

3. Run `cloudflared` as a Windows service so it survives reboots. Not verified here. See [Owner follow-ups](#owner-follow-ups-not-resolved-here).
4. Add a WAF rate-limiting rule on `<ingress-hostname>`. Set the threshold at or below the ingress ceiling of 120 requests per minute. Not verified here, and the spec lists no vendor URL for this step.
5. Add a Cloudflare Access application on `<ingress-hostname>`. Give it a Service Auth policy. Create a service token and attach it to that policy. Not verified here. Sources: [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/), [service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).
6. Do not add an identity or email policy to this application. A non-interactive caller cannot sign in, so an identity or email policy blocks the Grok bot.
7. Hand the Grok bot two things: the service token's Client ID and Client Secret as request headers, and its per-bot reply token as the bearer token. Whether a Grok bot can store a secret and send extra headers is not verified here. The spec tracks this as assumption A5 and open question Q8, and the live Grok smoke closes it.

With Access in front, Access answers an unauthenticated probe from outside the network and Sigil does not. Only a request that carries the service-token headers reaches the Sigil gate.

### Start the relay with the ingress

Set the secrets in the shell first. Replace each `<...>` with the real value at the prompt of your own session, and never save the values in a file under the repo.

```powershell
$env:SIGIL_DATABASE_URL = Read-Host 'SIGIL_DATABASE_URL'
$env:SIGIL_ROOM_BOT_KEY_WRAP_KEY = Read-Host 'SIGIL_ROOM_BOT_KEY_WRAP_KEY'
```

Then start the relay with the ingress flags added to your existing `sigil relay up` flags.

```powershell
sigil relay up --port 8791 --room-bot-key-wrap-key SIGIL_ROOM_BOT_KEY_WRAP_KEY --ingress-origin https://<ingress-hostname>
```

The relay reads the database URL from `SIGIL_DATABASE_URL` when `--database-url` is absent. The `--room-bot-key-wrap-key` flag takes the name of an environment variable, the same as `sigil bot add`. The relay exits non-zero and starts no listener in any of these cases.

- `--ingress-origin` is not a bare `https:` origin.
- No database URL is set.
- `--room-bot-key-wrap-key` is missing.
- `--port` is zero.
- Two of the four ports are equal.
- `--ingress-rate-per-minute` is not a positive integer.

Point the bridge at the same origin. The bridge refuses an `http` reply URL unless the host is loopback.

```powershell
sigil agent run --room-bridge floor-warden --floor-warden-reply-url https://<ingress-hostname>
```

Add the rest of your usual `agent run` flags. The bridge builds the reply URL as `<reply url>/v1/rooms/<room_id>/replies`.

### Create a reply token

Create one token for each bot. The command prints the plaintext once and stores only a SHA-256 hash.

```powershell
$token = sigil bot token create --bot-id <bot-id> | Select-Object -Last 1
```

Optionally add `--expires-in-days <n>`. Put the token in the Grok bot's secret store. Do not echo it, log it, or paste it into a file. To list tokens without plaintext:

```powershell
sigil bot token list --bot-id <bot-id>
```

## Plant a canary token

A canary is a reply token that never authorizes a reply. Plant one where an attacker might steal it. If it is used, the ingress answers `401 UNAUTHENTICATED` with the same body as an unknown or revoked token, writes an `ingress.canary_used` audit event with `token_id` and `bot_id` only, and does not run the accept path.

```powershell
$token = sigil bot token create --bot-id <bot-id> --canary | Select-Object -Last 1
sigil bot token list --bot-id <bot-id>
```

List shows `canary` in the status column. Revoke still works. Rotate creates a new active token and leaves canaries unchanged.

After a suspected hit, run `sigil ingress status` and look for `ingress.canary_used` in the audit log. Status still shows the canary token id and status. A canary use does not update `last_used_at` the way a successful reply does.

```powershell
sigil ingress status
```

Do not put the canary plaintext in the repo, a log, or an issue.

## Fall back to Tailscale Funnel

Use Funnel only to unblock the first smoke test when Cloudflare is not ready. Do not run production traffic through it.

Funnel carries these limits.

- It has no edge authentication. Anyone with the URL can reach it.
- It has no edge rate limit. Only the ingress limits and the per-bot limits in Sigil apply.
- It applies a bandwidth limit that you cannot configure. Tailscale publishes no number for it.
- It serves only names under the tailnet's `ts.net` domain, which this runbook writes as `<funnel-hostname>`. It listens only on port 443, 8443, or 10000, and it requires TLS.

Source: [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel).

Tailscale Serve is tailnet-only, so Grok's cloud cannot reach it. Source: the same page. Use plain Tailscale for local and mesh access, not for the Grok path.

1. Enable Funnel for the tailnet and the PC in the Tailscale admin console. Not verified here.
2. Run `tailscaled` as a Windows service so Funnel survives reboots. Not verified here.
3. Publish the ingress port on port 443. Not verified here, including the exact flag spelling.

   ```powershell
   tailscale funnel --bg 8796
   ```

4. Start the relay with `--ingress-origin https://<funnel-hostname>`, as in [Start the relay with the ingress](#start-the-relay-with-the-ingress).
5. Delete the Funnel after the smoke test.

   ```powershell
   tailscale funnel reset
   ```

   Not verified here.

## What never goes in the repo

Do not commit any of these in any file, test, log line, issue, or PR description.

- The real hostname, including `<ingress-hostname>` and `<funnel-hostname>` values.
- A reply token, a bearer token, or a Cloudflare service-token Client ID or Client Secret.
- A Cloudflare account ID, zone ID, tunnel ID, or tunnel credentials file.
- A database URL or the room bot key wrap key.

Pass secrets only through environment variables. The commands in this runbook name the variable and never carry the value on the command line. Do not open or commit any `.sigil/*.json` file. Run the repo secret scan before you commit any change to this file.

```powershell
node sigil/scripts/secret-scan.mjs
```

## Rotate a reply token

Rotation creates a new token and retires the old active token. The old token keeps working until the grace period ends. The grace period defaults to 1440 minutes, which is 24 hours.

```powershell
$token = sigil bot token rotate --bot-id <bot-id> | Select-Object -Last 1
```

To set a shorter grace period:

```powershell
$token = sigil bot token rotate --bot-id <bot-id> --grace-minutes 60 | Select-Object -Last 1
```

Update the Grok side with the new token before the grace period ends. Then confirm the old token is `retired` and the new one is `active`.

```powershell
sigil bot token list --bot-id <bot-id>
```

If a token leaks, do not wait for the grace period. Revoke it at once and create a new one. A revoked token answers `401 UNAUTHENTICATED`, the same as an unknown token. The command needs both IDs.

```powershell
sigil bot token revoke --bot-id <bot-id> --token-id <token-id>
sigil bot token create --bot-id <bot-id>
```

`sigil bot disable --bot-id <bot-id>` stops a bot entirely. It is the intended control for a bot you want off.

## Use the kill switch

To stop the exposure, restart `sigil relay up` without `--ingress-origin`. The relay then starts no ingress listener. No database change is needed, and existing tokens stay in the database.

```powershell
sigil relay up --port 8791 --room-bot-key-wrap-key SIGIL_ROOM_BOT_KEY_WRAP_KEY
```

Keep your other usual `relay up` flags. While the relay is down, the tunnel stays up and the provider answers `502` on the hostname. To remove the public hostname's path entirely, also stop the tunnel service. Not verified here.

```powershell
Stop-Service cloudflared
```

To turn the ingress back on, restart the relay with the `--ingress-origin` flag again.

## Check the ingress with status and doctor

Run `sigil ingress status` to see tokens and recent traffic. It reads Postgres from `SIGIL_DATABASE_URL`, or from `--database-url`. For each bot it prints the token ID, status, age, `last_used_at`, and the count of replies accepted in the last hour.

```powershell
sigil ingress status
```

Run `sigil ingress doctor` from a machine that is not on the PC's LAN, so it tests the real public path. It never sends a reply token. It probes the public origin and prints a pass or fail line for each check.

```powershell
sigil ingress doctor --origin https://<ingress-hostname>
```

When Access is in front, set the two service-token values in environment variables and pass the variable names. The flags take names, never values.

```powershell
$env:CF_ACCESS_CLIENT_ID = Read-Host 'CF_ACCESS_CLIENT_ID'
$env:CF_ACCESS_CLIENT_SECRET = Read-Host 'CF_ACCESS_CLIENT_SECRET'
sigil ingress doctor --origin https://<ingress-hostname> --access-client-id-env CF_ACCESS_CLIENT_ID --access-client-secret-env CF_ACCESS_CLIENT_SECRET
```

Pass both flags or neither. Doctor sends the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers on its probes when you do.

Doctor runs these checks.

| Check | Expected |
|---|---|
| Reply gate: unauthenticated `POST` to a fake room path | `401 UNAUTHENTICATED` from Sigil |
| Root route: `GET /` | `404` |
| Rooms route: `GET /v1/rooms` | `404` |
| Certificate | Valid |
| Port overlap | None |

Without the Access flags, Access answers the probe before Sigil does. Doctor then reports "blocked at the edge, the Sigil gate was not reached" and does not claim a pass. It tells the two apart by the standard Sigil error shape in the response body.

Doctor cannot see the flags of the running relay. To test a non-default port layout, pass `--relay-port`, `--stream-port`, `--public-port`, and `--ingress-port`. Their defaults are the relay port, plus 1, plus 2, and plus 5, from a relay port of `8791`. When two ports are equal, doctor prints each overlap and the hint about the 8792 and 8793 stream-port collision.

## Symptoms and recovery

| Failure | What you see | Recovery |
|---|---|---|
| Tunnel provider process down | Grok's request fails with a provider `530` or `502`. The invocation ends `REPLY_TIMEOUT` with a visible `invocation_failed` event. | Run `Restart-Service cloudflared`, then `sigil ingress doctor`. Whether the reply still lands depends on the bot's retry. |
| PC asleep or relay down | Same symptoms. The bridge is also down, so no new forwards happen. | Wake the PC or restart the relay. |
| DNS or certificate problem | Grok's request fails at connect. Doctor reports `certificate check failed`. | Fix the hostname or certificate at the provider. |
| Postgres down | `503 DATABASE_UNAVAILABLE`. | Restore Postgres. A retry with the same `idempotency_key` then succeeds. |
| Signing key or wrap key missing | `503 BOT_SIGNING_UNAVAILABLE`. | Set `--room-bot-key-wrap-key` or fix the key row. |
| Token leaked | An attacker can post one reply per running invocation of that bot. | Run `sigil bot token revoke --bot-id <bot-id> --token-id <token-id>` at once, then `sigil bot token create --bot-id <bot-id>`. |
| Token rotation | The old token works for 24 hours, or for `--grace-minutes`. | Run `sigil bot token rotate --bot-id <bot-id>`. Update the Grok side within the grace period. |
| Request flood | `429 RATE_LIMITED`. Auth-failure log lines aggregate to one per 10 seconds. | Tighten the Cloudflare WAF rule, lower `--ingress-rate-per-minute`, or use the kill switch. |
| Kill switch | The ingress listener disappears and the hostname answers `502` from the provider. | Restart the relay without `--ingress-origin`. No database change is needed. |
| Two listeners on one port | The relay refuses to start and prints the ports. | Set four distinct ports. |
| Late reply after Stop or `REPLY_TIMEOUT` | `403 ROOM_NOT_INVOKED`. Nothing is posted. This is by design. | None. |
| Duplicate delivery | `202` with `duplicate: true`. | None. |
| Relay restarts with the ingress up | `cloudflared` stays up and answers `502` during the gap. | Wait for the relay. The caller's retry applies. |
| Disabled bot | `403 BOT_NOT_ON_ROSTER`. | `sigil bot disable` is the intended control. |

The same `403 BOT_NOT_ON_ROSTER` also appears when a token for one bot names another bot as `target_bot_id`.

## Know when the ingress is proven

Do not retire the old listener until all three of these hold.

1. The transport smoke test passes from outside the network. Use a phone hotspot or another machine off the LAN, a fixture bot, a disposable room, and a disposable database whose name ends in `_test`. Never use a real bot for this test. Expect `401` without a token and `202` with a valid token against a running fixture invocation. When Access is in front, expect a call without the service-token headers to get its answer from Access and not from Sigil.
2. A real Grok reply lands in a room.
3. Seven days pass with no ingress incident.

The smoke procedure is in `docs/superpowers/plans/2026-10-17-sigil-rooms-phase-7-tunnel.md`, Task 15. It starts only after you approve provider setup in writing and supply the hostname. Chris has not yet approved the real bot endpoints, the routine URL, or the sender key.

## Owner follow-ups, not resolved here

These sit outside the repo. This runbook lists them and does not resolve them. Chris owns them.

- **Run `cloudflared` as a Windows service.** Add it beside the `SigilMeshDaemon` scheduled task, so the tunnel starts at boot. Not verified here.
- **Move the database credential out of the daemon script.** The credential is written inline in the daemon start script. Move it to an environment variable.
- **Reconcile the stream port.** The daemon script uses 8792 and the mesh skill uses 8793. With relay port 8791, the public listener also defaults to 8793, so the two collide. The ingress default of 8796 does not touch either port.
</br>
