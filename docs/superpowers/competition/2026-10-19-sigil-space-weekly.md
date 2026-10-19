# Sigil space weekly analysis, 2026-10-19

Draft for review. Checked 2026-10-19, as a diff against the 2026-10-18 baseline (merged in PR #71). The watchlist has 27 targets, 24 from last week plus 3 new. (V) means read in a saved snapshot whose checksum verified on 2026-10-19, or read directly on the vendor page on 2026-10-19 where stated. (U) means unverified. Snapshots live on the box, not in this repo.

## Summary

Reason Network shipped signed approvals and Grok CLI support, which narrows Sigil's lead on approvals and widens its gap on Grok coverage. Three hosted cross-owner room products entered the watchlist, and AgentCouch is the credible one. Four decisions are open, and the first is the hybrid design Q2 default for cross-owner senders.

## What changed this week

### Features

- Reason Network v0.10.6, released 2026-10-18 12:41 PM ET, adds Grok CLI support through hooks in ~/.grok/config.toml and hooks/reason-network.json, keyed on GROK_SESSION_ID (V). It also adds an ask_user tool. An agent asks its own person through an Approve/Deny pop-up on that machine and waits up to 10 minutes (V).
- Reason Network v0.10.7, released 2026-10-18 5:41 PM ET, adds signed approvals (V). It also adds DeepSeek Harness support (V).
- Post-release main on Reason Network forgets sessions gone for a day, along with their unread mail (V). Stars rose from 322 to 470 and forks from 27 to 38 (V).
- endue 2026.10.18 adds MCP access per agent for Claude Code, Cursor and VS Code, with per-agent opt-in (V). It adds a secretary that splits work across agents, and a space-admin conversation with approval cards (V).
- Threadlines now calls itself an "open-source ADE" and adds "several agents in one thread" and "agents start their own threads" to the README. The site adds Muse Code and Pi, and Grok is still listed (V). Stable is still v0.6.1, with v0.7.0 nightlies (U).
- Crosswalk rewrote its homepage use-case copy and added `-s user` to its MCP install lines. Grok Bot is still listed (V). The change is not material.

### Pricing

- Concord Cloud (Concord MCP, getconcord.ai) moved from waitlist to open sign-up, "Free while in early access", through `concord cloud login` (V). Stars rose from 541 to 551 (V).
- endue now has one credit balance at 1 credit = 1 USD, shared across endue AI and endue OS (V). Plans are unchanged at Free, Pro $15, Max $75 and Ultra $600 per month (V).
- Reason Network pricing is unchanged and free (V).

### License

- Reason Network license is unchanged (V). Concord MCP is still MIT (V). endue license is still unknown (U).

### Security claims

- Reason Network signs the approval answer. The Approval record carries request id and sender, approver, decision, request text, question, note and time, signed with the approver machine's key. The receiving machine drops it unless it verifies (V, DESIGN.md).
- Reason's own DESIGN calls this "a speed bump, not a guarantee", since software controlling the approver's machine can still sign (V).
- Reason's DESIGN now says a session that skips permission prompts holds a message from a stranger for its user unless the inbound setting is accept (V).
- The Reason message Envelope still has no signature field. Its fields are id, from, to, reply_to, thread, body and sent_at (V).
- endue adds purpose-scoped API keys and approval modes: always ask, secretary approves, approve everything (V).
- No other security-claim changes were found.

### Grok Bot and MCP integrations

- Concord MCP still names Grok Build (V from 2026-10-18).
- Last week eight targets named Grok or Grok Bot. AgentCouch adds an explicit Grok Bot install path and Reason Network adds Grok CLI support, so at least nine targets now name Grok or Grok Bot (V).
- endue added MCP access per agent this week (see Features). Grok was not seen there (U).

### No material change

- Alook (v0.1.55), Block Buzz, Agent Relay, AX, Portal and others showed stats only. Hyperagent reformatted its changelog into an index, with no new RSS entries after 2026-10-14 (V).

## New entrants

Added 2026-10-19.

- AgentCouch (agentcouch.dev, Morphologic AI Inc., British Columbia). Credible: HIGH.
  - Hosted MCP rooms for agents of different owners, teammates, customers and partners (V).
  - Free plan: 1 member, 10 rooms, 3 people per room, and rooms may include two people outside the workspace (V). Pro is $5 per seat per month and adds admin, roles and audit (V).
  - Explicit "Install with Grok Bot" path, plus Claude Code, Claude desktop, Codex, Cursor, Grok Build, OpenClaw and mcp-remote clients (V).
  - Everyone in a room, including the other party's human, reads the full transcript on the web (V).
  - The workspace goes read-only after a 14-day grace period if payment lapses (V).
  - Launch date unknown (U). No security page found, 404 (U).
- Concord (concord.fenginwind.com), a different product from Concord MCP (V). Credible: MEDIUM.
  - Cross-owner durable rooms, installed with `npm i -g concord-agent` and joined with `concord join claude|codex|gemini` (V).
  - Claims idle costs zero tokens, un-addressed messages wake nobody, targeted wake, approval-required join and prompt-injection defense. It also claims "Destructive operations are always gated to the human at the terminal, never to a chat message" (V as claims, not audited).
  - A commitment ledger is "coming next" (V).
  - Pricing page is behind sign-in (U). Lists Claude Code, Codex, Gemini and Cursor, and no Grok was seen (U).
- SharedNet (sharednet.ai, SysteMind, Inc.). Credible: MEDIUM.
  - Persistent rooms where coding agents talk. Every agent has an address, an agent wakes when the room speaks, and joining works by reading a skill.md (V).
  - Ran the Trial Zero agent hackathon on 2026-09-27, so it was live before the first baseline and was missed then (U).
  - Pricing page returned 404 (V). No Grok was seen (U).

## Follow-ups on 2026-10-18 decisions

This section reports status only. The 2026-10-18 decisions stand.

- Item 4, Hyperagent message edit. The vendor changelog still lists "Edit your room messages to correct eligible text in an active room you've joined" under the 2026-10-05 entry (V, read on the vendor page 2026-10-19). The manage-a-room FAQ "Can I edit a message after posting it?" exists, but its answer text was not captured (U). What "eligible" means, whether agents or the API can edit, and whether edits are shown or audited are unknown (U). The feature was not tested. The claim is confirmed, the details are open, and nothing needs action.
- Item 6, Reason CLI terms. Still unknown. The network page still says the engine is open source under Apache 2.0 and "The Reason CLI that sets it up is not" (V). Fetching reasonmachines.com/terms returned product marketing content, not terms text (V), so the CLI terms remain unread (U). The engine license is unchanged at MIT OR Apache-2.0 per NOTICE and README (V). Dependency licenses are still not audited.
- Item 7, tincan. No change. The Reason Network README still offers "Coming from tincan?" migration and team links ending in #tincan1, and DESIGN still uses ALPN tincan/1 over iroh QUIC (V). A search of Sigil origin/main c1cb304 on 2026-10-19 found no iroh, larstalian or ALPN references (V). Sigil's tincan bridge is still a Sigil-local Tailscale tsnet protocol, so the result stands: no interop, no license obligation.

## What it means for Sigil

Sigil facts below come from repo docs and code at origin/main c1cb304. Reason claims carry the labels from above.

### Where Sigil leads

- Sigil signs every envelope, and the relay rejects a reused message_id with REPLAY_DETECTED. Reason signs only roster and approvals, not envelopes (V).
- Sigil has governed rooms with human and bot membership. AgentCouch shows the full transcript to every human in a room (V), and Hyperagent team rooms are open to every workspace member (V).
- The tincan bridge holds high-risk actions in an immutable queue keyed by sha256(signedBytes(envelope)) and releases them only after a WebAuthn approval challenge. This is stronger than Reason's signed approvals, which Reason itself calls a speed bump (Reason claim V, comparison is analysis).

### Where Sigil is weaker

- The lead on approvals narrowed again, because Reason now signs approval answers (V).
- Grok coverage is thinner. At least nine targets name Grok, and AgentCouch and Reason added Grok paths this week. Sigil's phase 7 tunnel and MCP shim are not built, so Grok cloud replies cannot reach Sigil yet. Sigil also has no Grok CLI hook path.
- Setup takes more steps. AgentCouch, Concord (fenginwind) and Reason each join with one command or one pasted line. Sigil has no one-command setup yet.
- Cross-owner rooms are now a product category with three hosted entrants. Sigil's hybrid rooms and direct messages design is written but not built.

### What to borrow

These are options, not decisions.

- Reason's Approval record fields (request id and sender, approver, decision, shown text, time) as the shape for Sigil's approval result.
- Concord's rule that destructive operations are gated to the human at the terminal, never to a chat message, stated as a Sigil rule.
- Concord's idle-zero-tokens targeted wake, which matches the loop guard work.
- Reason's rule that a session skipping permission prompts holds stranger messages.

### What to ignore

- endue pricing and credits. It is a personal-agent product, not a relay.
- The Threadlines rebrand. It is a single-user desktop tool.
- Crosswalk copy changes. They do not change the product.
- SharedNet hackathons. They are marketing events, not product changes.
- AgentCouch pricing, since Sigil is not priced.

## Decisions for Chris

1. Answer hybrid design Q2 now: default inbound policy for cross-owner senders, hold or refuse? Recommendation: hold. Reason now holds stranger messages for sessions that skip permission prompts, and Concord (fenginwind) gates destructive operations to the human, so hold matches the field and keeps cross-owner rooms usable.
2. Add a check that Sigil's WebAuthn approval result reaches the far side as a signed record the receiver verifies, before the signed HALT work? Recommendation: yes, as a read-and-test task only. Reason shipped signed approvals this week, and the Sigil docs read for this run do not say whether the approval result itself is signed for a remote receiver.
3. Watch cadence for the three new entrants? Recommendation: AgentCouch weekly as core, since it is hosted cross-owner MCP rooms with a Grok Bot path. Concord (fenginwind) and SharedNet weekly for two more runs, then reassess.
4. Should the Grok Bot MCP shim spike also cover Grok CLI hooks, the way Reason added them in v0.10.6? Recommendation: no. Keep the spike to Grok Bot over MCP as decided, and log Grok CLI hooks as a follow-up after the spike.

## Sources that could not be read

- crosswalk.to/private: HTTP 404.
- hyperagent.com/pricing, /security and /trust: HTTP 404 each.
- agentrelay.com/pricing: HTTP 404.
- kodama.run: HTTP 503, deployment paused.
- reasonmachines.com/terms: returned marketing content, no terms text.
- AgentCouch security page: not found (404).
- Concord (fenginwind) pricing: behind sign-in.
- SharedNet pricing: HTTP 404.
- Alook pricing amounts: JS-rendered, not loaded.
- Plasma Radio pricing and license: not on the page.
- endue license: not found.
- X posts: not read.
