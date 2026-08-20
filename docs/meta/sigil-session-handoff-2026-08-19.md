# Sigil Session Handoff — 2026-08-19

## Summary of Session Accomplishments

1. **Multi-Model Sovereign Architecture**:
   - Added worker adapters for local sovereign LLMs ([`sigil/scripts/ollama-worker.mjs`](file:///C:/dev/sigil-repo/sigil/scripts/ollama-worker.mjs)) and OpenAI/Grok ([`sigil/scripts/openai-worker.mjs`](file:///C:/dev/sigil-repo/sigil/scripts/openai-worker.mjs)).
   - Updated architecture diagrams and docs across [`README.md`](file:///C:/dev/sigil-repo/README.md) and [`docs/wiki/README.md`](file:///C:/dev/sigil-repo/docs/wiki/README.md) featuring Google Antigravity, xAI Grok, and local Ollama/vLLM runtimes.

2. **Automated GitHub Wiki Sync Pipeline**:
   - Created [`.github/workflows/wiki-sync.yml`](file:///C:/dev/sigil-repo/.github/workflows/wiki-sync.yml) triggering on push to `main` when `docs/wiki/**` changes.
   - Created reusable [`sigil/scripts/sync-wiki.mjs`](file:///C:/dev/sigil-repo/sigil/scripts/sync-wiki.mjs) mapping `docs/wiki/README.md` to `Home.md` and pushing directly to the repo wiki git backend.
   - Added `"wiki:sync": "node sigil/scripts/sync-wiki.mjs"` to `package.json`.

3. **Delivery Outcome Routing & CI Separation**:
   - Fixed `outcome === 'processed'` routing in [`sigil/connectors/v1/relay-client.mjs`](file:///C:/dev/sigil-repo/sigil/connectors/v1/relay-client.mjs) to call `/processing` instead of `/ack`.
   - Allowed `processed` target state in [`sigil/relay/v1/http-server.mjs`](file:///C:/dev/sigil-repo/sigil/relay/v1/http-server.mjs) and [`sigil/relay/v1/report-processing.mjs`](file:///C:/dev/sigil-repo/sigil/relay/v1/report-processing.mjs).
   - Split [`.github/workflows/ci.yml`](file:///C:/dev/sigil-repo/.github/workflows/ci.yml) into `test-linux` (with Docker postgres service container) and `test-windows` (native execution without service container).

4. **Security & WebAuthn Ceremony Hardening**:
   - Fixed script-injection XSS in [`sigil/relay/v1/approval-ui.mjs`](file:///C:/dev/sigil-repo/sigil/relay/v1/approval-ui.mjs) using `safeJsonForScript()`.
   - Fixed package re-exports in [`index.js`](file:///C:/dev/sigil-repo/index.js) and added [`index.test.mjs`](file:///C:/dev/sigil-repo/index.test.mjs).
   - Routed `POST /v1/approval-challenges/:id/assertion` ahead of bearer auth so browser users can complete ceremonies without a relay token.
   - Eliminated credential enumeration oracle by checking challenge existence/expiration prior to credential lookups.
   - Implemented bounded rate limiting (`recordAttemptAndCheckLimit`) with 15-minute sliding window, 5,000-entry capacity limit, and 10-attempt cap.
   - Removed `Host` header fallback, requiring server-configured `relayOrigin`.
   - Supported dynamic bound port resolution (`() => string`) in [`sigil/cli/sigil.mjs`](file:///C:/dev/sigil-repo/sigil/cli/sigil.mjs) so ephemeral port 0 binds cleanly.
   - Allowed localhost HTTP origins in development while enforcing `https:` for remote hosts.
   - Added distinct `RELAY_ORIGIN_UNCONFIGURED` error code for unconfigured origin 500 responses.

5. **Audit Trail & Real-time ISO Timestamps**:
   - Standardized ISO timestamp capture strictly when `relay.sendEnvelope()` resolves in [`sigil/cli/send-with-receipt.mjs`](file:///C:/dev/sigil-repo/sigil/cli/send-with-receipt.mjs).

6. **Peer Review Clean Wrap**:
   - Completed full multi-agent review loop with `ep_claude` across commits `caf0495`, `6ed54af`, `21d504e`, `688a8e2`, `bd15cb0`, and `f2f0384`.
   - Confirmed 100% clean with zero remaining defects by `ep_claude` via message `msg_028c999f`.

---

## Architectural Learnings & Next Priorities

1. **Agent UX & The Need for an MCP Server**:
   - Interactive CLI polling (`sigil inbox --wait`) is prone to idle windows because LLM agents sleep between turns.
   - Immediate next priority is packaging a native Sigil MCP Server (`sigil-mcp-server`) with tools (`sigil_send`, `sigil_inbox`) and live subscription resources (`sigil://inbox`) to provide an event-driven experience across Antigravity, Claude Code, and Codex.

2. **Test & Conformance Metrics**:
   - 327 passing tests (0 failures, 30 skipped).
   - 100% JCS conformance across 116 files.
   - Remote branch `main` at commit `f2f0384`.
