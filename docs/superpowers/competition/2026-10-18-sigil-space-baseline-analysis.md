# Sigil space baseline analysis

Status: draft for review. Date 2026-10-18. Baseline run with no week-over-week diff yet. The first diff is the 2026-10-19 Monday scan. Chris decided all seven open questions on 2026-10-18. The results are recorded in the Decisions section.

Labels: (V) means read in a saved snapshot whose checksum was verified on 2026-10-18. (U) means unverified. Competitor Command Center holds the snapshots on the box, and they are not in this repo.

## Summary

Block Buzz, Agent Relay and Reason Network each claim part of the trust story Sigil leads on, so that lead is narrower than it was.
Reason Network is a repo created 2026-10-16 with 322 stars (V), and it already ships one-command setup, invites and a Grok Bot path that Sigil lacks.
Eight targets name Grok or Grok Bot (V): Reason Network, Crosswalk, Plasma Radio, Threadlines, Agent Relay, Concord MCP, AX and OpenCouncil. Sigil cannot receive Grok cloud replies until the phase 7 tunnel exists.
Crosswalk is a neighbor for shared memory and inbox, not a transport rival, and its $49 price belongs to a different product.

## Sources

- The sigil-space baseline of 2026-10-18 covers 24 targets. The snapshots are on the box, and the checksums verified OK.
- The hybrid rooms and direct messages design and decisions doc is on main under docs/superpowers/specs. Its Reason Network comparison section is in draft PR #70.
- The phase 7 tunnel design is in draft PR #67.
- The 2026-10-16 Sigil versus Hyperagent gap analysis and the 2026-10-16 rooms research brief are working notes kept on the box. They are not in this repo.

Statements about Sigil come from those docs and from the relay code in main, not from snapshots.

## Targets that could not be read

- Alook pricing. The page is JS-rendered and shows "Loading plans".
- Plasma Radio pricing and license. The page has no pricing, only Terms of Service.
- endue license and agent integrations.
- Hyperagent security and trust pages. Both return 404.
- Agent Relay /pricing. It returns 404.
- Perplexity primary blog. Only the secondary source AI Primer was saved.
- X posts. They are not readable.
- Kodama. kodama.run returns 503 DEPLOYMENT_PAUSED and the repo was not found.
- Concord MCP GitHub API snapshot. It is an empty file, so the star count and release cannot be verified.
- Webex, Slack, Zenzap, Teamily and OpenCouncil. Each has one page snapshot.

## Findings by group

### Seeds

- **Reason Network.** A P2P team directory and messaging tool for coding agents, with a live view of who is on which computer and repo and whether they are busy or idle (V).
  The network page names Grok Bot, Muse, Claude Code, Codex and Cursor as agents, and Grok Bot is reached through Reason MCP (V).
  It is free, and cloud Reason sessions bill as usual (V as stated; billing detail U); the repo has 322 stars, and the latest release is v0.10.5 on 2026-10-17 (U).
  The engine license is "MIT OR Apache-2.0", confirmed from the license files (V, see Decision 6). The Reason CLI is not open source and its terms are unknown (V). The NOTICE says the project began as tincan and was renamed and modified by Reason Machines, Inc. (V). Sigil's tincan bridge is a Sigil-local protocol and does not target this project (V, see Decision 7).
  The claims are E2E-encrypted traffic, a signed roster, per-machine inbound policy, loop and rate guards, and a relay that sees ciphertext only. They were read in the README and DESIGN but not audited (U). The DESIGN Envelope lists no signature field and does not describe replay protection (V), and "Zero data retention, SOC 2" is marketing (U).
- **Crosswalk.** "Message boards for all your AI agents": a shared-memory and message-board MCP server at mcp.crosswalk.to with feed, inbox, tasks, files, calendar, notes and public or private crosswalks, and not a live agent-to-agent transport (V).
  The $49 a month price (list $99) is SquadRoom, a separate product, and crosswalk itself is free on every plan (V).
  Chris's Google AI Mode summary matched the snapshots on hosted MCP, free server, email address, notes and shared crosswalks (V).
  The server is not published (U), and the GitHub repo has no license, mirrors public posts only and has 1 star (V). Its claims are email magic link, OAuth 2.1, revocable per-agent keys, immutable posts, approval of exact text before publishing, and a secret and PII scan on public posts, none audited (V as claims).
  Grok Bot is a listed supported agent with "Muse and Grok Bot" pair guides (V). No signed envelopes, receipts or governed human and bot rooms were found, and membership is account-based (U).
- **Hyperagent Rooms.** Hosted workspace rooms where people and workspace agents share one roster, in beta since 2026-09-24, with per-agent modes (joins-conversations or mentions-only), reply threads, Stop, Owner/Manager/Member roles, webhooks and schedules (V).
  Team rooms are not private, since every workspace member can see and join (V). The trust and security pages return 404 (V), webhooks use a shared-secret header (U), and agents run under the owner's account (V).
  Pricing is monthly plans from $20 to $10,000 per month with a free allowance and no per-room price (V), annual and PAYG plans ended 2026-08-26 (U), and the license is proprietary, "All rights reserved 2026, Hyperagent" (V).
  Custom MCP is an integration (V), and Grok appears as a model, not as an external agent in a room (U).
  The changelog RSS snapshot lists only titles and dates (V). The 2026-10-05 edit item is now confirmed in Hyperagent's own changelog page (V, 2026-10-18, see Decision 4), and it contradicts the 2026-10-16 brief line "messages can't be edited". The 2026-10-14 item about inviting colleagues to several rooms is still unverified (U).

### Core

- **Plasma Radio.** A link-joined channel where "any agent that can fetch a URL" joins, including Claude Code, Codex, Cursor, OpenCode and Grok, and the demo lists ChatGPT, Claude and Grok (V).
  The research page was published 2026-09-14, and the product is part of "Fractal", coming soon (V). It uses a plain URL protocol, not MCP (U).
  Pricing and license are unknown and the product is closed with Terms of Service only (U). The baseline note says anyone with the link can read and post in external channels (U), while the saved page says "All agents welcome" (V). No encryption or audit claims were seen (U).
- **Alook.** Rooms and DMs for people plus local coding-agent bots with persistent identity, where agents stay on the owner's machine (U).
  It is Apache-2.0 with 1,418 stars, 212 forks, 92 open issues and a last push on 2026-10-18 (V).
  It supports Claude Code, Codex, Cursor, OpenCode and Pi, with no Grok in the README (U). Plans are named Free, Studio and House, with amounts not loaded (U).
- **Block Buzz.** An open-source workspace from Block on a Nostr relay, with channels, threads, git and workflows, where agents are first-class members. The README lists per-agent Schnorr keys, NIP-42 auth, signed events, a hash-chain audit log, Postgres and Redis (V).
  It has 36,114 stars (V), and the baseline note gives Apache-2.0 (U).
  It uses Goose, Codex and Claude Code over ACP plus MCP tools, with no Grok mention found (U). Block hosts a managed version at an unseen price (U), and approval gates have infrastructure but unfinished glue (U).
- **Threadlines.** A local desktop workspace where Rooms put several coding agents in one thread, and agent-to-agent requests ask the user first by default (U).
  It is MIT with 16 stars (V), and the site lists Grok among providers (V).
  The latest stable release is v0.6.1 (U), though the snapshot holds only v0.5.0 release notes.
- **endue.** An always-on personal AI teammate with spaces and rooms, where a moderator routes to members (U).
  Monthly prices in USD are Free, Pro $15, Max $75 (adds SSO and SLA) and Ultra $600 (V).
  License and agent integrations could not be read (U).
- **Portal.** A Discord bridge where one relay holds the bot token, agents are tokenless webhook personas, history is durable, and a Claude Code channel exists. The README lists per-persona permissions, an audited admin panel and scoped invites (V).
  It has no license file, 2 stars, 5 forks and 14 open issues (V), and no Grok was seen (U).
  The 2026-10-16 brief calls it closest in shape to Sigil's relay (U).

### Extras

- **Agent Relay.** Channels, DMs and threads for agents and teammates, with a hosted product and an open-source core under Apache-2.0 (U), and 887 stars (V).
  The trust page lists scoped agent credentials, per-flow approval gates and bring-your-own model keys. It says the product does not yet have enterprise SSO, workspace-wide emergency controls, a customer-visible security audit log, or a completed SOC 2 or pen-test claim (V).
  Claude Code, Codex, Cursor, OpenCode and Grok appear in the marketing UI (V), MCP is used for session history (U), and pricing is "free to start" with /pricing returning 404 (U).
- **Concord MCP.** An open-source, local-first MCP layer for messaging, file claims, handoffs and review packets, licensed MIT (V).
  The README names Grok Build, Claude Code, Codex, Cursor, Gemini CLI and Goose and writes .grok/config.toml (V). It has a telemetry section that environment variables can disable (V heading; details U).
  Concord Cloud is a waitlist with no price (U), and stars and release cannot be verified.
- **AX / Agent Exchange.** A local Go broker where named sessions on one machine message each other, with optional Tailscale pairing, supporting Claude Code, Codex CLI, Grok Build, OpenCode and Pi (V).
  It is MIT with 7 stars (V) and free (U).
- **mcp_agent_mail.** A FastMCP tool with Git and SQLite inboxes, threads and advisory file leases, plus a commercial iOS companion (U).
  The license shows as NOASSERTION (U), it supports Claude Code, Codex and Gemini CLI, and Grok is not explicit (U).
- **RelayRoom.** A self-hosted MCP board with Postgres pub/sub and tmux wake, licensed AGPL-3.0 (U).
  It supports Claude Code, Codex and Antigravity (U).
- **Murmur.** A local MCP bus from instavm under Apache-2.0, stale since July (U). Low priority.
- **acommune.** A self-hosted relay with a tamper-evident SQLite room log, no license and 0 stars (U). Low priority.

Seen but not watched (U): Kodama (down), xtalk, intermind, agents-party, agentbus, Paseo, and Hermes loop-guard issues #32791 and #89545, which are a turn-taking signal only.

### Adjacent

- **Slack Code channels.** Slack developer changelog snapshots show agents spawning per-task Code channels (U).
- **Webex.** A Cisco newsroom release dated 2026-10-07 covers agentic collaboration (V), and the brief gives full rollout in Q1 2027 (U).
- **OpenCouncil.** AIToolly reported a Product Hunt launch on 2026-10-15 of live voice rooms for human teams and models including GPT, Gemini and Grok, with a moderator and a Scribe decision log (V, secondary source).
- **Teamily AI.** A Human+AI messenger with a public launch press release dated 2026-07-08 (V).
- **Zenzap.** A knowledge-base page titled "Set who can add AI agents" (V), with per-tool approval unconfirmed (U).
- **A2A CLI.** An A2A protocol blog post dated 2026-10-01 introduces a CLI client for A2A agents (V), and the baseline note gives Apache-2.0 (U).
- **Perplexity Projects.** A secondary report (AI Primer, 2026-10-12) says agents commit to S3-backed Git repos with short-lived locks and head checks (V as a secondary report). The primary blog was not read.
- **Claude Managed Agents multi-agent.** The docs page is marked Beta and has a "Session budgets" section (V), and exact caps are unknown (U).

## What it means for Sigil

Sigil facts below come from repo docs, not snapshots, so they carry no label except where FACTS gave one.

### Where Sigil leads

- Signed envelopes. Reason Network's DESIGN Envelope lists no signature field (V), and Crosswalk has none that was found (U). Block Buzz claims signed events (V), so it is not behind here.
- Replay rejection in the relay (V in repo docs). The relay rejects a reused message_id with REPLAY_DETECTED and writes an envelope.rejected.replay_detected audit event. Reason's DESIGN does not describe replay protection (V), and no other captured claim mentions it (U).
- Delivery receipts. Crosswalk has none that was found (U), and no other target's captured claims mention receipts (U).
- Governed rooms with human and bot membership. Crosswalk membership is account-based (U), and Hyperagent team rooms are open to every workspace member (V). Hyperagent does share one roster and has roles, so the overlap is close (V).
- Postgres-backed relay. This is not a lead on its own, since Block Buzz uses Postgres (V), Crosswalk runs on Supabase Postgres (V), and RelayRoom uses Postgres pub/sub (U).
- The lead is narrower than it was. Block Buzz claims signed events and a hash-chain audit log, Agent Relay claims scoped credentials and approval gates, and Reason Network claims a signed roster and inbound policy.

Sigil's receipts, replay rejection and room governance are read from repo docs and code, and none of the competitor claims about them were tested.

### Where Sigil is weaker

- Setup and invite flow. Reason Network offers one install then `reason network setup`, plus `reason network invite` (V). Sigil's hybrid design lists no one-command setup and no team invite flow. This weakness comes from the Reason Network comparison in draft PR #70.
- First-class Grok Bot or MCP path. Reason Network, Crosswalk, Plasma Radio, Agent Relay, Concord and AX, among others, each name Grok or Grok Bot (V). Sigil has the Floor Warden bridge for Grok cloud bots, but no MCP path.
- Phase 7 tunnel not built. Grok cloud replies cannot reach Sigil until it exists. The design is in draft PR #67, with Q2 provider, Q5 endpoints and Q8 Grok secrets and retries still open, and the real bot endpoints and Floor Warden webhook are not yet created.
- Hyperagent gaps. The list comes from the 2026-10-16 gap analysis, a working note that is not in this repo: room notes and canvas, webhooks and schedules, reactions, find-in-room, room directory, usage panel, archive, slash commands and approval cards.

### Options to borrow

- Option, not a decision: one-command setup and team-link invites, modeled on Reason Network.
- Option, not a decision: a Grok Bot MCP shim, modeled on the Reason MCP and Crosswalk paths.
- Option, not a decision: loop guards with a visible "paused at cap" state and a signed in-band HALT.
- Option, not a decision: signed webhooks, since the 2026-10-16 brief says they beat shared-secret ones.
- Option, not a decision: per-room cost caps, per-agent watermark and catch-up, and an optional visible-moderator router mode.
- Option, not a decision: approvals bound to the account-owning identity.

### What to ignore for now

- Murmur and acommune. Both are low priority, with Murmur stale since July and acommune at 0 stars with no license.
- mcp_agent_mail and RelayRoom. Both are single-machine or self-hosted MCP boards with a different shape from a signed relay.
- Kodama and the other targets seen but not watched. Kodama is down, and the rest have no snapshot.
- Webex, Slack Code channels and Perplexity Projects. The evidence is page-only or secondary, and the Webex rollout date is unconfirmed.
- Crosswalk as a transport competitor. It is a neighbor for shared memory and inbox, and its Grok Bot path is the only reason to keep watching it.
- The still-unverified 2026-10-14 Hyperagent invite item, until a changelog page confirms it. The 2026-10-05 edit item is no longer in this group.

## Decisions

Chris decided all seven on 2026-10-18; each is "Decided 2026-10-18: yes, as recommended."

1. Build a Grok Bot MCP shim? Decided 2026-10-18: yes, as recommended. Build it as a small spike beside the phase 7 tunnel. The tunnel is still blocked on Q2, Q5 and Q8, and eight targets name Grok or Grok Bot (V): Reason Network, Crosswalk, Plasma Radio, Threadlines, Agent Relay, Concord MCP, AX, OpenCouncil.

2. Prioritize one-command setup and team-link invites? Decided 2026-10-18: yes, as recommended. Do both, with setup first.

3. Order of loop guards and signed HALT? Decided 2026-10-18: yes, as recommended. Build loop guards first, then signed HALT.

4. Verify the Hyperagent "Edit your room messages" claim before acting? Decided 2026-10-18: yes, as recommended. Verify the claim first, then act on the result. Result (found, V, fetched 2026-10-18): Hyperagent's own changelog page https://www.hyperagent.com/docs/changelog/2026-10-05-model-control-image-edits-short-video (dated 5 October 2026, title "Let Hyperagent choose the model for you") lists under "Other updates": "Edit your room messages to correct eligible text in an active room you've joined." The claim is confirmed as a vendor statement. It is a one-line bullet. The page does not say what "eligible" means, whether agents or an API can edit, or whether edits are shown or audited. The "Working in a room" page https://www.hyperagent.com/docs/concepts/rooms/working-in-a-room lists message actions as copy text, copy link, mark unread, open agent activity, react, reply in thread, and does not mention edit. The feature was not tested. The 2026-10-16 brief line "messages can't be edited" is out of date and should be corrected in that working note (kept on the box, not in this repo).

5. How often to check each competitor? Decided 2026-10-18: yes, as recommended. Keep Agent Relay and Concord weekly. Check Murmur, acommune and mcp_agent_mail less often.

6. Confirm the Reason Network license before any reuse? Decided 2026-10-18: yes, as recommended. Confirm the license from the source repo before any code reuse. Result (V, read 2026-10-18 in the reason-machines/reason-network repo): the engine is dual-licensed "MIT OR Apache-2.0". The files LICENSE-APACHE and LICENSE-MIT exist, and Cargo.toml, NOTICE, CONTRIBUTING.md and the README all say "MIT OR Apache-2.0". The site page and the GitHub license badge list only Apache-2.0, which is one of the two options, so they do not conflict. Still unknown: the terms of the Reason CLI (stated as not open source), and the licenses of the engine's dependencies were not audited. Check those two first before any code reuse.

7. Does Sigil's tincan bridge target Reason Network or upstream tincan? Decided 2026-10-18: yes, as recommended. Check the bridge code and docs before assuming any interop. Result (V, code and docs read 2026-10-18): the bridge targets a Sigil-local protocol. It does not target Reason Network or upstream larstalian/tincan. README.md lines 346-355 describe it as transport over a private Tailscale (tsnet) mesh with Tailscale WhoIs node-key allowlisting plus Sigil Ed25519 identity, push-to-wake, and a held queue released by WebAuthn approval. sigil/relay/v1/transport-tincan/tincan-relay.mjs is an HTTP server with DISPATCH_PATH '/v1/dispatch' and CALLBACK_PATH '/v1/approval-callback' (lines 15-16). It calls `tailscale whois --json` (line 85) and binds to the Tailscale IPv4 from `tailscale ip -4` (line 349). whois-auth.mjs (lines 3-15) checks the Tailscale Node.Key against an allowlist of permitted endpoints. wake-dispatcher.mjs (lines 7-12) spawns `node sigil/cli/sigil.mjs agent run --room-bridge <kind>`. held-queue.mjs binds to the relay action hash. A repo-wide search of the Sigil worktree found no mention of iroh, larstalian, the reason-network binary, or the ~/.reason paths in code. The only references to Reason Network are the design comparison docs under docs/superpowers/specs (hybrid DM decisions Q7 and the hybrid design doc), which treat it as an unverified reference. Sigil's tincan plan and handoff docs in this repo do not cite upstream tincan or Reason Network. The code shares no protocol or code with either, and the docs do not say why the name was chosen. Reason Network (and upstream tincan, now archived; its README says it became Reason Network) uses an iroh QUIC transport (direct on LAN via mDNS, hole-punched, relay fallback), ALPN "tincan/1" with length-prefixed JSON frames, and Envelope{id: ulid, from, to, reply_to, thread, body, sent_at} with acks stored|delivered|held|refused. It also has a signed replicated roster and a per-machine daemon with a local unix socket and MCP tools list_team and send_message. These are different protocols, so the two cannot talk to each other. There is no interop or license obligation from this bridge. Any interop would need an adapter and is not decided.

## Next run

The Monday 2026-10-19 scan will produce the first diff against this baseline. The weekly analysis PR follows that scan.
