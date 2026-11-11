# Sigil direction vs competitors

Nov 11, 2026 · Chris Sorensen

> Copy of the review doc as of 2026-11-11, committed for tracking. Read-only review: nothing here was run live, and UNVERIFIED marks are kept as written.

## Recommendation

**Stop competing on join friction and room UI. Position Sigil as the verifiable, owner-governed relay: the layer you use when agents owned by different people act on each other's behalf and someone later needs proof of who said what.** Then earn that position with one real cross-vendor reply before anything else.

Tags: VERIFIED = read today in a source; INFERRED = my reading of verified facts; UNVERIFIED = could not confirm; SNAPSHOT-ONLY = only in the Nov 9 snapshot, not re-read.

### 1. Positioning

- **Against hosted chat rooms and networks** (Reason Network, Crosswalk, Concord Cloud): they win on one-paste join, hosted MCP and traction. Sigil cannot out-onboard a YC-backed hosted network. Its claim is different: every message carries an Ed25519 signature over JCS that a third party can check after the fact, and cross-owner invocation is governed (holds, `invokable_by`, subject inheritance). Reason authenticates machines and signs approvals, but its message envelope has no signature field, and hosted bots connect through Reason's server. (VERIFIED facts; the contrast is INFERRED.)
- **Against protocols** (SCP, A2A): SCP has the closest design (wake, consent federation, untrusted framing) but leaves message fields to relays and authenticates by bearer credential. A2A authenticates the transport, not the message. Sigil is the only one in the field that makes the message itself evidence. (VERIFIED for SCP quotes and A2A; "only one" is INFERRED from the 40-target watchlist plus today's reads.)
- **Against local desktop boards** (Friday, Scranton, Hellhound, AgentsRoom, Harness Relay): do not build a board. Boards are free, multiply weekly, and the platforms are absorbing them (Antigravity /swarm board, dormant Grok Bot shared rooms). Sigil should be the relay a board could sit on. (VERIFIED that the products exist; platform moves UNVERIFIED beyond headlines.)

### 2. Double down, pause, drop

| Call | Capability | Why |
| --- | --- | --- |
| Double down | Signed envelope + a standalone transcript verifier | It is the one property no watched competitor has; today it is invisible to users. |
| Double down | Cross-owner governance (holds, `invokable_by`, audit, revocation) | Approved one-link design depends on it; SCP and Reason are converging here. |
| Double down | Grok path: Floor Warden, reply ingress, per-bot credential, remote MCP | Reason already ships Grok Bot MCP plus webhook wake; this is the live race. |
| Double down | Formal checks (lease checker, TLA+ watch model) | Cheap, and they back the "verifiable" claim. |
| Pause | Federation (inter-relay trust, libp2p, federated `stream_seq`) | No traffic needs it until a second owner is on one relay. |
| Pause | New CLI bridges (Grok CLI, Hermes, Antigravity) | Gate on the cancellation read-and-test already proposed. |
| Pause | macOS launchd (#178), PWA and Web Push (7b), AgentMail expansion | Hosting stays on Chris's machine; none sits on the proof bar. |
| Drop | Feature parity with hosted rooms and boards (web composer polish, star-count chasing) | Unwinnable and off-thesis. |
| Drop | Global reply token on the ingress for anything beyond tests | Per-bot credentials are the approved model; the flag is a foot-gun once guests join. |
| Drop (later) | Relay-custodial guest signing keys as the long-term guest model | Shared-box secrets are fleet-wide; guests should hold their own keys or passkeys. |

### 3. Ranked 30/60/90 plan

Respects the Nov 10–11 decisions: one-link is the active track and Phase 7 is paused; Chief and Helix CI are gone; the first group is Grok Bot · Elon, First Mate · Orchestrator and Floor Warden on `rewritelabs.io` (endpoint names PROPOSED); bootstrap secrets live in a locked-down local file; the relay must pick up new bots without restarts (Task 3A). Nothing below touches the real database or creates a bot without Chris's go-ahead.

**Days 1–30 (to Dec 11)**

1. ~~Setup script Task 2: replace the migration connection log with fixed text. On main it still prints the database target with only the password masked. Gate for any wrapper run.~~ (Done Nov 11: merged as PR #191, `43e7120`, 4:48 PM ET.)
2. Finish the setup script on fixtures and a disposable database only: Task 3 (read-only inspection; open as PR #193 since Nov 11), Task 3A (automatic registry refresh, no restarts), then Tasks 4–7, with the Windows ACL proof in Task 4. Task 1 (the pure setup policy) is merged as PR #190.
3. Chris confirms the three endpoint names and Floor Warden's role (`dispatcher`, ordinary reply bot, or identity only). In parallel, engineers read metadata only: operator identity, WIN database label, configured relay domain, registry path and ACL, and whether the Floor Warden routine sends Bearer or HMAC.
4. With Chris's go-ahead: run the setup for the first group on the real database and land one real Grok reply in a room. This closes A1–A5 and starts the 7-day clock.
5. One-link for Chris's own bots: one credential per bot in its secret card, the connector preflight with `SCHEMA_STALE`, and atomic invite storage (Durable Object or SQLite, since the KV prototype is not atomic). Rerun the rejection tests on that path.
6. Fix doc lag: the STATUS.md lease entry, the restart line in `bot add` (Task 3A replaces it), and the PLAN line that says no task has begun.

**Days 31–60**

- Finish 7 incident-free days; retire the old listener.
- OAuth 2.1 on the Sigil MCP endpoint (approved Nov 10); cross-owner holds on by default for guest bots.
- Ship `sigil verify` for an exported room transcript, runnable by someone with no relay access.
- Broker on WIN (approved Nov 10): fix the isolation gap the OpenBao spike found before any upstream key moves in, then run a per-bot credential rotation and revocation drill.

**Days 61–90**

1. Pilot with one or two guest owners and their bots, with revocation drills.
2. Read-only note, then a spike: an A2A agent card or MCP facade so other front-ends can sit on Sigil.
3. Decide the Grok CLI bridge from the cancellation evidence; trim the watchlist.

**Single most important move:** finish the setup script through Task 3A with the logging fix, then land one real Grok reply in a room from the first group. Until that happens Sigil's lead is on paper.

## Evidence

Repo read at origin/main `d4c5000` (2026-11-10) and re-checked at `301300c` (2026-11-11, PR #190) before this commit. Competitor pages fetched 2026-11-11. The nine files Chris sent on Nov 11 were read the same day; rows that rest on them name the file.

### Sigil today

| Claim | Tag | Source |
| --- | --- | --- |
| Signs every envelope with Ed25519 over JCS (RFC 8785); required fields include `signature`, `expires_at`, `sender.owner_id` | VERIFIED | [A2A vs Sigil note](https://github.com/sorensencc-dotcom/sigil/blob/main/docs/superpowers/competition/2026-11-09-a2a-vs-sigil-envelope.md) |
| Rooms ride the same signed durable relay as tasks; MCP tools `sigil_list_rooms`, `sigil_read_room`, `sigil_post_message`, `sigil_dispatch_task`, `sigil_my_mentions` | VERIFIED | [README](https://github.com/sorensencc-dotcom/sigil/blob/main/README.md) |
| Guests get single-use 24-hour invite links; only the token's SHA-256 is stored; GitHub sign-in with 7-day sessions | VERIFIED | README |
| `invokable_by` owner/members with subject inheritance across hops; README names the residual risk that guest text still reaches agents | VERIFIED | README |
| Guest signing keys are relay-custodial (wrapped); bot signing keys are relay-held and cannot be rotated | VERIFIED | README |
| Floor Warden bridge built; no real Grok reply has landed in a room | VERIFIED | README, STATUS.md 2026-10-21 |
| Reply ingress transport proven 2026-10-20 via Cloudflare named tunnel + Access service token; A1–A5 still open | VERIFIED | STATUS.md 2026-10-21; SPEC §8 |
| Lease-renewal fix merged as PR #114 on 2026-10-25, so STATUS.md "local only" is stale | VERIFIED | git log `1caa958` |
| `relay_jobs` states are pending, processing, done, rejected, dead\_letter | VERIFIED | `sigil/migrations/021_relay_jobs.sql` |
| Checker `check.mjs` exists; `known-findings.json` is empty; commit `4ae8010` is on main | VERIFIED | `packages/relay-jobs-verification/` |
| 848 schedules, 0 failing properties on 2026-11-10 | UNVERIFIED (no file Chris sent mentions it; not re-run) | Chris's brief |
| Nov 11: Chief and Helix CI removed; first group is Grok Bot · Elon, First Mate · Orchestrator and Floor Warden, endpoints `ep_<name>@rewritelabs.io`. Names PROPOSED; Floor Warden's `dispatcher` role PROPOSED and its creation blocked until Chris confirms | VERIFIED (decisions) | OPEN-QUESTIONS, PLAN, SPEC headers |
| Domain `rewritelabs.io`, Q1/Q2/Q4 recommendations and Task 3A approved Nov 11, 3:49 PM ET; bootstrap secrets in a locked-down local file, broker not required first | VERIFIED (decisions) | OPEN-QUESTIONS Q1–Q4 |
| Whether the running relay uses that domain; operator identity; WIN database label; registry path and ACL; routine auth (Bearer vs HMAC); deployed auto-refresh | UNVERIFIED (the files say so; required before any `--apply`) | OPEN-QUESTIONS |
| Setup script Task 1 (pure default-deny policy, `sigil/cli/phase7-setup-policy.mjs`) merged to main as PR #190 (`301300c`) on 2026-11-11. PLAN reports 12/12 tests and 87/87 neighbour suites on Linux; Windows UNVERIFIED. ~~Task 2 not started~~ (Nov 11 update: Task 2 merged as PR #191, `43e7120`; Task 3 open as PR #193) | VERIFIED (merge); test counts VERIFIED in PLAN only | git log `301300c`; PLAN Task 1 gate |
| ~~Migration runner still prints the database target with only the password masked~~ (Fixed Nov 11 by PR #191: line 14 now logs fixed text) | VERIFIED | `sigil/scripts/apply-migrations.mjs:14` at `43e7120` |
| Relay loads token hashes once at start and `bot add` tells the operator to restart | VERIFIED | `sigil/cli/sigil.mjs:317`, `sigil/cli/bot-commands.mjs:139` |
| Grok Bot connector shows no caller identity, so each bot needs its own credential (live test, Nov 10, 9:01 PM ET) | VERIFIED (in brief; not re-run) | one-link brief |
| Per-bot credential prototype (Worker v2, KV) refused impersonation, invite reuse, wrong room, removal without host key, posting after removal and unknown credentials; two-bot retest passed 9:31 PM after a connector preflight. KV is not atomic | VERIFIED (in brief; not re-run) | one-link brief |
| Chris approved one credential per bot in its secret card, a broker on WIN and OAuth 2.1 on the Sigil MCP endpoint (Nov 10, 9:38 PM ET) | VERIFIED (decisions) | one-link brief |
| OpenBao + proxy spike: tests 1–5 and 7 passed, 6 partial. Brokering works; isolation does not, because Docker daemon access can mount the volumes. Infisical spike blocked before install | VERIFIED (in brief; not re-run) | one-link brief |
| Grok Bot connectors are account-wide and cannot tell bots apart; per-bot MCP auth must live in servers Chris controls | VERIFIED (research claim, cites MCP auth spec) | fleet-secrets brief |
| No one-link enrollment code and no Grok Bot MCP shim on main; the setup script so far is only the Task 1 policy module | VERIFIED (grep at `d4c5000`; only #190 landed since) | repo |
| STATUS.md on main has entries through 2026-11-07; the STATUS copy Chris sent ends 2026-10-25, so it is older than main | VERIFIED | STATUS.md, both copies |

### Competitors

| Product | What changed or matters | Tag | Source |
| --- | --- | --- | --- |
| [Reason Network](https://reasonmachines.com/network) | Now shows Y Combinator (F26) backing. Tools are `list_team`, `send_message`, `check_inbox`, `ask_user`. Hosted MCP at mcp.reasonmachines.com; Grok Bot path Bot settings > MCP Servers. New: `wake_me` sets up Grok Bot routine webhook wake. "Names are verified by Reason sign-in"; "hosted bots connect through Reason's server". Free; engine MIT/Apache, CLI closed. | VERIFIED | network page |
| Reason envelope | `Envelope{id: ulid, from, to, reply_to, thread, body, sent_at}`: **no signature field (claim confirmed)**. But machines authenticate over ed25519 iroh QUIC, roster entries are signed, and `ask_user` approvals travel as `Signed<Approval>`; DESIGN calls that a "speed bump". Latest tag v0.12.17; last commit 2026-11-07. | VERIFIED | [DESIGN.md](https://github.com/reason-machines/reason-network/blob/main/DESIGN.md), `src/proto.rs` |
| Reason vs message authenticity | A message accepted from a hosted bot rests on Reason's server and the receiving machine's word, not on a signature a third party can check | INFERRED | above |
| [Crosswalk](https://crosswalk.to) | Agent self-signup by one curl POST; MCP at mcp.crosswalk.to; email inbox per user; duo and group crosswalks across people. Claims 10,224 agents connected this week (was 9,314 on Nov 9). | VERIFIED page text; count is vendor marketing | home page |
| Crosswalk trust | A2A key equals MCP token; staff may open messages for support or abuse | SNAPSHOT-ONLY | Nov 9 weekly |
| [Concord](https://getconcord.ai) | Cloud mode with `concord cloud login`, file claims to avoid collisions, $0 and per-seat pricing, open-source MCP | VERIFIED | home page |
| Concord version v0.21.0, 1006 stars |  | SNAPSHOT-ONLY | Nov 9 weekly |
| [SCP](https://scp.dev) | Protocol v1. Wake for hibernated sessions via provider waker or hub webhook. Cross-account only through mutually accepted contacts; widening "MUST be confirmed by a person in the hub's interactive console". Optional judge (pass, redact, hold, refuse). Bearer account credential; "the broker does not verify peer credentials". | VERIFIED (quoted) | [spec](https://scp.dev/spec) |
| SCP signing | Standard message fields are set by relays; Ed25519 only for experimental mesh records and auth | INFERRED (from an extracted summary of the spec) | spec |
| A2A 1.0 | Auth via AgentCard securitySchemes; no per-message signature mandated | VERIFIED (Nov 9 note) | A2A note |
| Switch Rooms | Chat-tool channels become rooms; 4279 stars | SNAPSHOT-ONLY | Nov 9 weekly |
| Agent Relay, Threadlines, Alook, Friday, Hellhound, Scranton, Harness Relay | Local boards and relays, several with Grok Build in a room | SNAPSHOT-ONLY | Nov 9 weekly |
| [AgentsRoom](https://agentsroom.dev/es/blog/agentsroom-now-supports-grok-build) | Desktop board; added Grok Build as a provider beside Claude, Codex, Antigravity CLI | VERIFIED; not on the watchlist | blog post |
| Grok Bot native shared rooms | Reverse-engineered in Grok Bot 0.16.0: cross-account rooms, owner-approved invites, participants add agents; server said sharing not enabled. Article dated 2026-08-12; rest is members-only. | UNVERIFIED (third-party scoop, not confirmed by xAI) | [RuntimeWire](https://runtimewire.com/es/article/scoop-grok-bot-ships-dormant-shared-rooms-for-tasking-other-users-agents) |
| Antigravity /swarm | Headline: Nov 10 preview puts named workers and a shared message board inside Antigravity | UNVERIFIED (headline only) | RuntimeWire listing |

### What this means

- Reason has closed most of the Grok Bot gap Sigil is chasing: hosted MCP, OAuth sign-in identity, and webhook wake. Sigil's remaining edge on that path is per-message signatures and cross-owner governance. (INFERRED)
- Platform risk is rising: if Grok Bot or Antigravity ship native multi-owner rooms, standalone room products lose their reason to exist; a verifiable relay underneath does not. (INFERRED)
- SCP is the closest design peer. Its human-console rule for widening cross-account reach and its untrusted-content framing are worth borrowing. (INFERRED)

## Gaps that matter, in order

Chris's own bots come first; invited people and other owners' bots second. Ranked within each group by how much they block the proof bar or the one-link rollout.

### Chris's own bots

| Area | Sigil today | Best competitor | Gap and fix |
| --- | --- | --- | --- |
| Enrollment | Manual `bot add` plus a relay restart; setup script has only its Task 1 policy on main (PR #190) | Reason one paste line; Crosswalk one curl; Concord `cloud login` | Finish the setup script; Task 3A removes restarts. Then one paste after first connection (approved). Zero-click stays out of scope. |
| Identity | Per-bot reply token; Grok Bot connector shows no caller identity (live test Nov 10) | Reason: OAuth sign-in on hosted MCP names the account | One credential per bot in its secret card now (approved); OAuth 2.1 at day 31–60 (approved). |
| Wake | Floor Warden webhook for Grok; Tincan push over Tailscale for local | Reason `wake_me` wires Grok routine webhooks; SCP provider waker plus hub webhook | Parity once a real reply lands; add a documented polling fallback like Reason's 15-minute option. Confirm whether the routine sends Bearer or HMAC first. |
| Custody | Bot keys relay-held, cannot rotate; bootstrap secrets in a locked-down local file (approved Nov 11) | Reason keeps keys per machine; SCP stores only token hashes | Treat the shared box as fleet-wide. Broker on WIN is approved, but the OpenBao spike showed Docker daemon access breaks isolation: fix that before moving keys. Plan bot key rotation. |
| Verification | Signed envelopes, lease checker, TLA+ watch model | None sign messages | Make it visible: `sigil verify` on an exported transcript. |

### Invited people and other owners' bots

| Area | Sigil today | Best competitor | Gap and fix |
| --- | --- | --- | --- |
| Enrollment | Single-use 24-hour invites with revocation; GitHub sign-in. One-link prototype stores invites in KV, which is not atomic | Reason invite line; Crosswalk email invite to a duo crosswalk | Move invites to a Durable Object or SQLite before guests use them; add an invite that enrolls a guest's bot under their ownership, not Chris's. |
| Identity | Guest is a human endpoint; guest bots need a per-bot credential | SCP contacts both accounts accept | Cross-owner holds by default; borrow SCP's rule that widening reach needs a human console confirmation. |
| Wake | Guest bots wake through Chris's host | Hosted hubs wake anyone | Hosting stays on Chris's machine (approved), so guest wake depends on that machine's uptime. Say so in the invite. |
| Custody | Relay holds guest signing keys, wrapped | Reason: keys stay on each person's machine | Biggest trust gap for outsiders. Move guests toward self-held keys or passkeys before a wide pilot. |
| Verification | Guest posts are signed by the relay on the guest's behalf | n/a | A custodial signature proves the relay accepted it, not that the guest wrote it; label it that way in the verifier. |
| Context exposure | `invokable_by` governs starts, not reads; guests see full room history | SCP frames bodies as untrusted data | Add untrusted-content framing on delivery; default new guests to post-join history only. |

## Open questions

- Confirm the three endpoint names, and whether Floor Warden gets a `dispatcher` endpoint, an ordinary reply endpoint, or an identity with no roster row. This is the one decision that blocks the first group.
- Is the target user for the next 90 days Chris's own fleet only, or must a guest owner be live by day 90? The plan assumes a small pilot at day 61–90.
- Should guest signing keys stay relay-custodial for the pilot, or must guests hold their own keys first?
- Does the one-link remote MCP endpoint sit behind the same Cloudflare tunnel as the reply ingress, or a separate hostname? The files don't say.
- Can the 848-schedule checker result be re-run on CI so it is reproducible by someone else?
- Is there public traction you want (stars, users), or is Sigil a private fleet tool? This decides whether star counts belong in the weekly.

Chris sent nine files on Nov 11, and all were read: the one-link brief, the fleet-secrets brief, the Nov 9 facts and watchlist, the Nov 9 weekly (same as the repo copy), STATUS.md (an older copy than main), and the Phase 7 SPEC, PLAN and OPEN-QUESTIONS. The watchlist confirms 40 targets, with Globster on the monthly cadence and SCP and Switch Rooms weekly. Still not opened: the Cursor canvas (private), the full Grok CLI memo, and the snapshot files behind the facts file. Star counts and versions in the facts file come from Nov 9 snapshots, so they stay SNAPSHOT-ONLY. Crosswalk's trust page and Concord's protocol page were not re-read.

## Sources

- [Sigil repo](https://github.com/sorensencc-dotcom/sigil) at `d4c5000`: README, STATUS.md, migrations, `packages/relay-jobs-verification`, [Nov 9 weekly](https://github.com/sorensencc-dotcom/sigil/blob/main/docs/superpowers/competition/2026-11-09-sigil-space-weekly.md)
- Files Chris sent on Nov 11: the 2026-11-10 one-link join brief, fleet secrets 2026-11-10, facts 2026-11-09, watchlist.json, the Phase 7 SPEC, PLAN and OPEN-QUESTIONS, and a STATUS.md copy. Also read on main: sigil/scripts/apply-migrations.mjs, sigil/cli/bot-commands.mjs, sigil/cli/sigil.mjs.
- [Reason Network page](https://reasonmachines.com/network) and [reason-network repo](https://github.com/reason-machines/reason-network) at `5442c8b`
- [Crosswalk](https://crosswalk.to)
- [Concord](https://getconcord.ai)
- [SCP](https://scp.dev) and [SCP spec](https://scp.dev/spec)
- [AgentsRoom Grok Build post](https://agentsroom.dev/es/blog/agentsroom-now-supports-grok-build)
- [RuntimeWire Grok Bot shared rooms scoop](https://runtimewire.com/es/article/scoop-grok-bot-ships-dormant-shared-rooms-for-tasking-other-users-agents)
