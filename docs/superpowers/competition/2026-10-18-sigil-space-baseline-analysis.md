# Sigil space baseline analysis

Status: draft for review. Date 2026-10-18. Baseline run with no week-over-week diff yet. The first diff is the 2026-10-19 Monday scan.

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
  The repo license field says Apache-2.0 and the README says "MIT OR Apache-2.0" (V), the Reason CLI is not open source (V), and the NOTICE says the project began as tincan and was renamed and modified by Reason Machines, Inc. (V). Sigil has its own tincan bridge, and whether it targets this project is unchecked (U).
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
  The changelog RSS snapshot lists only titles and dates (V). The baseline note says 2026-10-05 added "Edit your room messages" and 2026-10-14 added inviting colleagues to several rooms, but the snapshot holds no such details (U). If the edit item is true, it contradicts the 2026-10-16 brief line "messages can't be edited".

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
- The unverified Hyperagent changelog claims, until the snapshot confirms them.

## Open questions for Chris

1. Should a Grok Bot MCP shim take priority over the phase 7 tunnel? Recommendation: scope the shim as a small spike beside the tunnel, because eight targets name Grok or Grok Bot (V): Reason Network, Crosswalk, Plasma Radio, Threadlines, Agent Relay, Concord MCP, AX and OpenCouncil. The tunnel is still blocked on Q2, Q5 and Q8.
2. Should Sigil build one-command setup and team-link invites? Recommendation: yes, start with setup, since Reason Network ships both and Sigil lists both as weaknesses.
3. Should Sigil add loop guards and a signed HALT from the 2026-10-16 brief? Recommendation: yes, loop guards first, since Reason Network claims loop and rate guards and Sigil has a hop budget and a per-agent concurrency limit.
4. Should the unverified Hyperagent message-edit claim be checked before anyone acts on it? Recommendation: yes, read the 2026-10-05 changelog entry directly in the next scan and hold the gap analysis until then.
5. Should the low-priority extras stay on the weekly watch list? Recommendation: keep Agent Relay and Concord weekly and check Murmur, acommune and mcp_agent_mail less often.
6. Should the Reason Network license be confirmed before any reuse? Recommendation: yes, read the LICENSE file first, because the repo field, the README and the "CLI is not open source" note differ.
7. Should Sigil check whether its own tincan bridge targets Reason Network? Recommendation: yes, a short check, since the NOTICE says Reason Network began as tincan.

## Next run

The Monday 2026-10-19 scan will produce the first diff against this baseline. The weekly analysis PR follows that scan.
