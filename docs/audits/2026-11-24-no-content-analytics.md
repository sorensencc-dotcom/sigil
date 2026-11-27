# Audit: no content analytics (issue #296)

Date: 2026-11-24. Branch: `docs/issue-296-content-analytics-audit`. Base: `origin/main`.
Slogan under test: "Signed messages. No content analytics."

## Verdict

PASS for the claim as worded, with three disclosures the public copy must not contradict. FAIL for any stronger claim ("we never read your messages", "end-to-end private", "content never leaves Sigil").

No code in this repository reads message content for analytics, and no analytics, telemetry, or tracking dependency or endpoint exists in the relay, the rooms-web console, the connectors, or the bridges. Message bodies are stored in plaintext in the relay database and are forwarded to third parties when a room invokes an external agent. Both are delivery, not analytics, and the claim has to say so.

## The line

- Delivery: moving a message body to the people, bots, and agents the room routes it to, and storing it so the room can show history and replay. Allowed.
- Content analytics: reading, counting, classifying, or summarizing message content for any purpose other than delivering it, or sending content or content-derived events to a system that does so. Not done anywhere in this repository.

## Method and limits

- Scope: this repository at `origin/main` (worktree `C:\dev\.worktrees\sigil-local-i296`). Relay (`sigil/relay/v1`), rooms-web console (`packages/sigil-rooms-web`), bridges (`sigil/bridges/v1`), connectors (`sigil/connectors/v1`), CLI (`sigil/cli`), ingress (`sigil/ingress/v1`).
- Trail was run first. Its index is the `C:\dev` workspace graph, not this worktree, so `trail grep "analytics"` returned only unrelated workspace files. The evidence below comes from searches scoped to the worktree directories, then reading each hit. Line numbers are from this worktree.
- Static review only. No running relay, no network capture, no production database or deployment config inspected.
- Not audited: the kb-sync repository (see item 2), the Floor Warden / Grok service on the receiving end of the webhook, AgentMail, Cloudflare, and Tailscale.

## Item 1: relay and room-bot logs, do any store message bodies?

Result: PASS for logs. Finding F1 for storage.

Evidence that logs and audit rows carry ids, not bodies:

- `sigil/relay/v1/hop-log.mjs:1-7`: `logHop` header says callers pass ids only, "never payloads or credentials". Every call site passes ids, statuses, and durations:
  - `accept-envelope.mjs:603-607` (message_id, sender_endpoint_id, conversation_id, status, duration_ms)
  - `floor-warden-replies.mjs:54,142`
  - `room-dispatch.mjs:164,190`
  - `stream-server.mjs:239,258`
- `sigil/relay/v1/postgres-repository.mjs:1912-1921`: `recordAuditEvent` writes event type, ids, outcome, reason, and a `payload` the caller builds. Callers inspected pass metadata only: `floor-warden-replies.mjs:148-152` (`request_id`, `status`), `accept-envelope.mjs:105-111` (resend range ids), `accept-federated-envelope.mjs:119,282` (origin and recipient domains), `peer-discovery.mjs:114-152` (keys and URLs).
- The only direct `console` calls in `sigil/relay/v1` are operational: `federation-reaper.mjs:337`, `http-server.mjs:49,1439`, `with-transaction.mjs:23`. None log an envelope or body.
- `sigil/relay/v1/metrics.mjs:1-28`: in-memory counters keyed by label. Labels in use are fixed enums such as `result`, `scope`, `job_type` (`reply-ingress.mjs:41-118`, `resend-worker.mjs:66-67`). No content-derived labels.
- Room-bot side: `sigil/bridges/v1/floor-warden-bridge.mjs:101,374,461,491` log invocation ids and the webhook origin only, with errors scrubbed (header comment at line 29). `room-router.mjs:58,73` and `room-bridge.mjs:96,106,151` log error messages only.

Finding F1 (storage, by design): the relay stores message bodies in plaintext.

- `postgres-repository.mjs:1282` inserts `body` (the envelope body) and `canonical_bytes` into `envelopes`. The signature covers integrity, not secrecy. There is no end-to-end encryption.
- This is what lets rooms show history, replay, and export signed transcripts (`sigil/cli/transcript-commands.mjs`). It is delivery, not analytics. The slogan must not imply the relay cannot read messages.

Finding F2 (low, local logs): bridge error logs can echo agent CLI stderr.

- `sigil/bridges/v1/cli-runner.mjs:68-71` builds `CLI_FAILED` errors from the child's stderr. `room-bridge.mjs:106` logs `error.message`. A CLI that echoes prompt text on failure would put some content in the local bridge log.
- Local only, nothing is sent anywhere, and no code reads those logs. Not analytics. Recommend truncating or dropping stderr in that message.

## Item 2: kb-sync connector service (#237, #278), does it index room content?

Result: PASS for this repository. Gap G1 for the kb-sync repository.

- `sigil/connectors/v1/mcp-memory-bridge.mjs:1-263` only proxies `/mcp/memory` JSON-RPC to the kb-sync memory server (`query_context_cache`, `fetch_topic_note`, `vfs_upsert_document`, lines 7-43). Nothing in the bridge reads rooms or the relay. `vfs_upsert_document` content is whatever an MCP caller sends.
- `sigil/cli/connector-daemon.mjs:35-71`: the daemon holds a `RelayClient` and an in-memory `LocalInbox`, used to forward tasks to the relay. With no `--relay-url` it runs memory-only and relay routes fail closed (line 35).
- `docs/decisions/2026-11-22-kb-sync-sigil-connector.md:79-89` and `docs/service-config.md:132-153` describe the connector as an isolated process on loopback port 4411, with its own config and identity, separate from the room stack.
- No code path in this repository copies room messages into kb-sync.

Gap G1: whether kb-sync itself ingests anything a room bot or connector writes through `vfs_upsert_document`, and whether the connector identity is a member of any room, is outside this repository. If the connector endpoint is ever added as a room member, it receives room messages as a delivery recipient. Confirm in the kb-sync repo and the live room membership before publishing.

Related note: `mcp-memory-bridge.mjs:132-136` sets `Access-Control-Allow-Origin: *` on `/mcp/memory`. Not an analytics issue. Authentication on that path was not reviewed.

## Item 3: Floor Warden and bridges, does content go to third parties?

Result: PASS as delivery. Disclosure D1 required.

- `sigil/bridges/v1/floor-warden-payload.mjs:39-73` builds the `room.message` frame: the trigger message text in full (line 58, never clipped), up to 20 prior thread messages clipped to 4000 characters each (lines 24-27, 41-45), sender ids and display names, and room id and name. Maximum frame size 256 KiB (line 25).
- `floor-warden-bridge.mjs:343` POSTs that frame to the configured webhook URL (the Floor Warden / Grok endpoint). `redirect: 'error'`, a 10-second default timeout, and a key header (lines 17-19).
- The bot's reply returns through `floor-warden-replies.mjs` and is stored as a room message. The audit row for the reply holds `request_id` and `status` only (lines 148-152).
- The frame includes earlier thread messages the bot was not mentioned in. Content the user did not address to the bot can reach the third party. This is still delivery of thread context to an invoked agent, but users should be told.
- Local CLI bridges (`claude-cli.mjs`, `codex-cli.mjs`, `copilot-cli.mjs`) pass the prompt to the vendor CLI the operator runs. Those vendors process the content under their own terms.
- No other outbound content path found. Other outbound HTTP from the relay: GitHub OAuth and OIDC discovery (`oauth/providers/github.mjs:14`, `oidc-client.mjs:15`, no message content), federation to peer relays (`accept-envelope.mjs:562`, signed envelope delivery to the recipient's relay), AgentMail ingress (`http-server.mjs:261-273`, inbound email, not room traffic).
- `sigil/relay/v1/model-router.mjs` is used only by `sigil/scripts/openai-worker.mjs:34`, an optional worker that an operator runs. It is not part of the relay or console.

Disclosure D1: when a room invokes an external agent, the trigger text and recent thread context are sent to that agent's provider. The claim "no content analytics" holds. A claim like "content never leaves your relay" does not.

## Item 4: web console and telemetry, any usage events that carry content?

Result: PASS.

- `packages/sigil-rooms-web/package.json:17-34`: dependencies are `react`, `react-dom`, `@tanstack/react-query`. No analytics, error-reporting, or session-replay SDK. Root `package.json:86-105` likewise has none (`svix` and `agentmail` are webhook verification and email ingress, not analytics).
- `packages/sigil-rooms-web/index.html:7-11`: one icon link and one module script, both same-origin. Fonts are shipped locally (`public/fonts/*.woff2`), not loaded from a font CDN.
- `packages/sigil-rooms-web/serve/server.mjs:41-47`: Content-Security-Policy `default-src 'self'` with `connect-src` limited to `'self'` plus the relay and stream URLs (or `wss://<public-origin>` in cookie mode). The browser cannot reach a third-party analytics host even if a script tried.
- Network use in `src/` is limited to `src/api/client.ts:53` (relay API), `src/config.ts:3` (`/config.json`), and `src/live/socket.ts` (relay WebSocket). No `sendBeacon`, `XMLHttpRequest`, or `new WebSocket` to other hosts. The only `console` call in `src/` is `useAck.ts:19`, which logs an error object for a failed ack.
- Searches for `analytics`, `telemetry`, `sentry`, `posthog`, `mixpanel`, `amplitude`, `gtag`, `plausible`, `datadog`, `opentelemetry`, and `sendBeacon` across `sigil/` (excluding tests) found no matches. Across `packages/sigil-rooms-web` they found no matches.

## Gaps

1. G1: kb-sync repository and live connector room membership not reviewed (item 2).
2. G2: the Floor Warden / Grok service, AgentMail, Cloudflare, and Tailscale process content under their own terms. This audit covers Sigil's code, not theirs.
3. G3: static review only. Deployed config (extra log shippers, reverse proxy access logs that record request bodies, database backups, host monitoring) was not inspected. A reverse proxy in front of the relay is the most likely place for body logging to appear outside this code.
4. G4: no regression guard. Nothing in CI fails if someone adds an analytics dependency, a content-bearing `logHop` field, or an external script. See recommendations.

## What blocks the slogan

Nothing in this repository blocks "Signed messages. No content analytics." Before publishing:

1. Confirm G1 (kb-sync) and G3 (deployment logs) with the operator.
2. Publish the supporting statement with the slogan, so the claim stays true: "Sigil stores and delivers your messages. It does not read them for analytics. Invoking an external agent sends that agent the message and recent thread context."
3. Do not pair the slogan with "end-to-end encrypted", "private", or "we never see your messages".

## Recommendations

- Add a CI test that fails when `package.json` or `packages/sigil-rooms-web/package.json` gains a known analytics or error-reporting package, and when `index.html` or the CSP references a non-self origin.
- Add a test that every `logHop` and `recordAuditEvent` payload key is on an allow-list of id and status fields.
- Truncate or drop CLI stderr in `CLI_FAILED` messages (F2).
- If the slogan is published, record the line in the README so future changes are checked against it.

## Recheck 2026-11-27

Verdict unchanged. Still PASS for "Signed messages. No content analytics." The slogan is not in the repo and is not published. `git diff 0ed1ffa..HEAD` (the audit commit through current `main`) adds no `analytics`, `posthog`, `sentry`, `sendBeacon`, `telemetry`, `gtag`, `plausible`, or `mixpanel` lines, and no `logHop(` call changes. Rooms-web still depends only on React and React Query. In-browser signature verification (`packages/sigil-rooms-web/src/verify/verifyRow.ts`) checks signatures locally.

Citations that moved, same behavior:

- Envelope body insert is `sigil/relay/v1/postgres-repository.mjs:1302`. `recordAuditEvent` is at line 1932 and still stores the caller-built `payload`.
- `CLI_FAILED` still copies child stderr into the error message at `sigil/bridges/v1/cli-runner.mjs:72`. `room-bridge.mjs:106` still logs `error.message`. F2 stands.
- Floor Warden forward payload is unchanged: full `trigger.text` at `sigil/bridges/v1/floor-warden-payload.mjs:58`, thread text clipped to 4000 characters, last 20 messages, 256 KiB cap.

G1, room indexing: closed for both repositories. `C:\dev\kb-sync` has no `room.message` hits in 324 indexed files. `vfs_upsert_document` refuses any path outside `wiki/` (`modules/cache/vfs-upsert.mjs:111-114`) and then stores that wiki page in `kb_documents`. Sigil's memory bridge still does not read rooms. kb-sync does store full signed envelopes, body included, in `local_approvals.envelope_json` for its own competitor-watch approvals (`watch-competitors-v2.mjs` `dispatchSigilEnvelope`). Those are kb-sync task envelopes, not Sigil room history.

## Limits inspected 2026-11-27

This host, not a dashboard.

Deployed logs and backups:

- Postgres `sigil` on `localhost:55432` (`sigil_postgres`, postgres:16-alpine) has `log_statement=none`, `log_min_duration_statement=-1`, `logging_collector=off`, `archive_mode=off`. The Docker json-file log for the last 72 hours has no `INSERT INTO envelopes` line and no line containing `body`.
- The data directory is Docker volume `74a004297e9eb0a2aa77da11071891007ec14c1b2f7a6e72b0b7ff73cfe41832`. That volume holds the plaintext envelope rows. No scheduled task argument mentions `pg_dump`, `sigil_postgres`, `55432`, or `docker volume`.
- `RewriteLabsDailyBackup` copies the rewritelabs-io site, wiki, and two SQLite files. It does not copy this database.
- `Cloudflared` is running (`tunnel run --token-file`). `C:\ProgramData\cloudflared` contains the token and no request log. Application events for the last week are service start lines only. `rooms.rewritelabs.io` and `sigil-ingress.rewritelabs.io` both resolve to Cloudflare (`104.21.80.87`, `172.67.176.159`). Relay ports 8791, 8796, and 8797 listen on `127.0.0.1` only, so those hostnames reach this PC through the tunnel. A room post and a bot reply therefore cross Cloudflare in cleartext at the edge. The Cloudflare account's log retention was not opened.
- Tailscale serve is tailnet-only. `/` proxies to `127.0.0.1:3773` (T3 Code) and `/mcp/memory` proxies to `127.0.0.1:4411`. It does not proxy the relay.

Third parties that receive text:

- The three running room agents (`grok_bot`, `first_mate`, `floor_warden`) use the floor-warden bridge. The webhook URL is an external HTTPS automation endpoint with a path and no query string. The host is not recorded in this repo. That POST is the trigger text plus up to 20 clipped thread messages. Replies return through the public ingress hostname to the loopback ingress on port 8796.
- Claude, Codex, and Copilot CLI bridges are not selected in `.sigil/service.json`. If one were, `cli-runner.mjs:76` would write the prompt to that process's stdin, and a failed CLI could still echo text into the local error log (F2).
- AgentMail is off. `SIGIL_AGENTMAIL_ENABLE` is unset for the user and the machine, and `service.json` does not load an AgentMail env file. The code path, when enabled, regex-scans the email body for financial and prompt-injection markers (`sigil/ingress/v1/classify.mjs:2-3`) and stores the classification label, not the body (`agentmail-provenance.mjs:37-46`). The normalized instruction is then delivered as a task. That scan is routing, and it is not running here.

Published in the README as "Signed messages. No content analytics." The supporting sentence names delivery, the agent thread handoff, and a proxy in front of the relay. It does not say end-to-end encrypted, and it does not say the relay never sees messages.
