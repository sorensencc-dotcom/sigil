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
