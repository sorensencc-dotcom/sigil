# Sigil space weekly analysis, 2026-10-26

Draft for review. Checked 2026-10-26, as a diff against the 2026-10-19 weekly (PR #73). The scan diff was 414 lines across 48 file hunks. Claims based on saved vendor snapshots are (U). Claims about Sigil come from repo docs at origin/main 00cca7e and are (V).

## Summary

Reason Network moved the most. It shipped many 0.12.x releases, rewrote its join flow around one pasted line, and now documents a hosted MCP URL for Grok Bot (U). That raises the bar for the Sigil phase 7 tunnel and the unbuilt MCP shim (V). SharedNet's home page now shows a Decisions dashboard for approving another owner's agent (U). Hyperagent pricing became readable after a 404 last week (U). Concord, Alook, and AgentCouch changed little in product terms (U). This week adds three new decisions.

## What changed this week

### Features

- Reason Network join flow: paste "Join the Reason Network: https://reasonmachines.com/network" to a coding agent, or run `curl -fsSL https://reasonmachines.com/install.sh | bash -s -- network`. Sign in with Google, GitHub, Apple, or email. (U)
- Reason hosted assistants (Grok Bot, Muse, ChatGPT, and others) add the MCP URL `https://mcp.reasonmachines.com/mcp`. The network skill.md tells hosted assistants not to install on the cloud computer and to use MCP instead. Grok Bot routines and webhooks are mentioned for wake. (U)
- Reason lists these agents: Claude Code, Codex, Cursor, Gemini CLI, Copilot CLI, opencode, Pi, Grok Bot, Muse, Dots, Reason sessions. Tools are list_team, send_message, check_inbox, ask_user. (U)
- Reason added a `reason-network bridge` JSON-lines subprocess for native adapters. A Hermes plugin path is documented. (U)
- Reason session naming rules expanded. A name stays with the conversation, is kept while offline, and is forgotten after a day. (U)
- Reason now allows small text file attachments: up to 10 files, 256KB each, 512KB total. ZCode Desktop MCP setup was added. (U)
- Reason transport stays iroh. DESIGN now mentions iroh 1.4 where it said 1.3. Default relays are Reason's own, listed at reasonmachines.com/network/relays.json, not n0 public relays. (U)
- Reason latest release is v0.12.13, published 2026-10-25 6:22 AM ET. The prior latest was v0.10.7 on 2026-10-18. Many 0.12.x releases landed in between. (U)
- Reason stars went from 470 to 1253 and forks from 38 to 106. (U)
- SharedNet home was rewritten (diff ratio 0.487). It now shows Rooms, Network map, Dashboard Decisions (approve or deny another owner's agent), and Goals (coming soon). (U)
- SharedNet claims agents join with three HTTP requests over plain HTTP. It states "Release 1.0 is on staging." Clients listed: Claude Code, OpenClaw, Codex, WorkBuddy, OpenHands, Cursor, Hermes Agent. No Grok client is listed. (U)
- Crosswalk home.txt was rewritten (ratio 0.694). It adds Claude Duet beside Muse, many pair guides, "sealed rounds" (an LLM council), tasks, and an agent pages directory. Grok Bot is still listed in pairs. (U)
- Crosswalk squadroom-pricing.txt (ratio 0.384) turned from a plans page into a "Connect SquadRoom to other AI agents" MCP how-to. SquadRoom connects through `https://mcp.crosswalk.to` to post and read a shared board with Muse, Grok Bot, Claude, ChatGPT, and Codex on a schedule. (U)
- Concord MCP README adds GitHub Copilot CLI to the client list and Antigravity docs. It adds a self-contained installer, `curl -fsSL https://getconcord.ai/install.sh | sh`, which bundles Node under ~/.concord/standalone. New commands are `concord check` and `concord watch`, plus an events.jsonl artifact. Grok Build and .grok/config.toml are still listed. (U)
- Concord stars went from 551 to 696. Latest release is v0.16.0, published 2026-10-22 7:14 PM ET. (U)
- Alook rebranded its slogan to "Multi-Agent Collaboration for Team and Friends" (commit 2026-10-26). Home was rewritten toward Claude Code and Codex collaboration. Releases v0.1.58 (2026-10-24) and v0.1.59 (2026-10-25) shipped. Stars went from 1422 to 1464. (U)

### Pricing

- Hyperagent pricing.txt returned 404 last week and now returns 200 with full pricing. Free is $0 per month with allowance limits. Paid budgets run from $20 to $10,000 per month with bonus credit: $100 gets $115, $500 gets $625, $2000 gets $2700. Credits do not roll over. (U)
- Reason pricing is unchanged: free, no card. (U)
- Crosswalk still states $49 per month early access (list $99), unlimited agents, 1000 research credits. The page was updated 2026-10-24. (U)
- Alook pricing now shows a Free, Studio, House structure. Amounts still render as "Loading..." and limits show placeholder marks. The page needs JavaScript. (U)
- Concord is still described as free early access cloud. No pricing change was claimed this week. (U)

### License

- Reason is unchanged. The engine is MIT OR Apache-2.0. The Reason CLI is not open source. (U)
- Concord MCP is MIT. No change. (U)
- No other license changes were seen in the diff. (U)

### Security claims

- Reason envelopes are still Envelope{id, from, to, reply_to, thread, body, sent_at}. There is no signature field. (U)
- Reason approvals are still signed Approval records. DESIGN still calls them a "speed bump, not a guarantee." (U)
- Reason added sign-in proofs for joining and invite links in the rn1 format. A commit message says agents never get the reusable team link in context. (U)
- SharedNet claims agents join over plain HTTP. No signing or transport claim was seen. (U)
- Hyperagent security and trust pages still return 404. No claim can be read. (U)
- Sigil signs every envelope, and the relay rejects a reused message_id. (V)

### Grok Bot and MCP integrations

- Reason documents Grok Bot as a hosted assistant that joins through MCP, with routines and webhooks for wake. (U)
- Crosswalk lists Grok Bot in pairs and connects it to SquadRoom through MCP. (U)
- Concord still lists Grok Build and .grok/config.toml. (U)
- AgentCouch still has a Grok Bot install path. (U)
- SharedNet lists no Grok client. (U)
- Sigil has a phase 7 tunnel design. Grok cloud replies still need the tunnel, and the MCP shim for Grok Bot is not built. (V)

### No material change

- AgentCouch home.txt changed only in whitespace and newlines. Product claims are unchanged. (U)
- Endue changed only locale and footer text. (U)
- Hyperagent llms.txt and docs copy were reworded (agents, skills, workspaces). No dated feature entry was confirmed in the changelog read, so this counts as copy churn. (U)
- Crosswalk README board counts rose (deals 319 to 459, and similar). These are stats only. (U)
- Agent Relay, Plasma, Threadlines, Portal, Slack Code, Webex, and Zenzap show no material product change in the diff headers. (U)
- Opencouncil, perplexity-projects, and claude-managed-agents show tertiary news and doc churn. They are not rooms or relay competitors. (U)

## New entrants

None this week.

## Follow-ups on prior decisions

Status only.

From PR #71 (2026-10-18):

- All 7 decisions were approved as written. No open items. (V)

From PR #73 (2026-10-19):

1. Other owners' agents: hold, not refuse, by default. Approved. The hybrid design is written and not fully built. (V)
2. WebAuthn approval as a signed verifiable record before signed HALT: approved as a read-and-test. The WebAuthn approval ceremony exists in the repo. Verifying the far-side signed approval record has not been reported as done. (V)
3. Weekly watch: AgentCouch stays core weekly. Concord (fenginwind) and SharedNet get two more weekly runs, then reassess. This report is run 2 of those two. The reassess question is item 2 under Proposed decisions. (V)
4. Grok Bot MCP shim stays Grok Bot over MCP only. Grok CLI hooks are logged as a follow-up. The shim is not built. (V)

Doc lag: PR #73 was merged 2026-10-19. The file hybrid-dm-decisions.md on origin/main still lists Q2 as undecided in its text. This is a doc lag, not a new decision. (V)

Older follow-ups:

- Hyperagent message edit: details are still open. (U)
- Reason CLI terms: still unknown. The CLI is not open source, and no terms page was read. (U)
- tincan: still Sigil-local, a Tailscale tsnet bridge. Reason uses iroh ALPN tincan/1. There is no interop, and the prior decision stands. (V for Sigil, U for Reason)

## What it means for Sigil

Sigil facts are from repo docs at origin/main 00cca7e (V). Reason and vendor claims carry (U).

### Where Sigil leads

- Sigil signs every envelope. Reason's envelope has no signature field. (V for Sigil, U for Reason)
- The Sigil relay rejects a reused message_id. No equivalent claim was seen from Reason, SharedNet, or Crosswalk. (V for Sigil, U for others)
- Sigil has a WebAuthn approval ceremony in the repo. Reason still calls its signed approvals a "speed bump, not a guarantee." (V for Sigil, U for Reason)
- SharedNet's plain HTTP join claim is weaker than Sigil's signed transport. (V for Sigil, U for SharedNet)

### Where Sigil is weaker

- Reason joins with one pasted line and a hosted MCP URL. Sigil has no one-paste join. (V for Sigil, U for Reason)
- Grok cloud replies still need the Sigil tunnel, and the MCP shim is not built. Reason, Crosswalk, and AgentCouch already document Grok Bot paths. (V for Sigil, U for others)
- Reason shipped a run of 0.12.x releases in a week and its stars rose from 470 to 1253. Sigil has no matching public traction signal in the repo docs. (U)
- SharedNet shows a working Decisions dashboard for cross-owner admit. The Sigil hybrid design is written and not fully built. (V for Sigil, U for SharedNet)

### What to borrow

- Reason's hosted MCP URL for Grok Bot and Muse. Use it as a timing signal for the phase 7 tunnel and the MCP shim. (U)
- Reason's bridge and Hermes adapter pattern: a JSON-lines subprocess for native adapters. (U)
- SharedNet's Decisions dashboard shape for cross-owner admit, matched to the "hold" default from PR #73. (U)
- Concord's standalone installer and `concord check`, as a model for conflict hooks. (U)

### What to ignore

- Alook's new slogan. (U)
- Hyperagent pricing for Sigil product choices. Sigil is unpriced. (U for Hyperagent, V for Sigil)
- Crosswalk board count churn. (U)
- Tertiary news and doc sites (opencouncil, perplexity-projects, claude-managed-agents). (U)

## Proposed decisions

1. Spike a one-paste join skill for Sigil, like Reason's "Join the Reason Network: <url>" line and the AgentCouch paste. Reason now also ships hosted MCP at mcp.reasonmachines.com for Grok Bot (U). Sigil has no one-paste path today (V). Recommendation: yes, a time-boxed spike for local agents only, with no hosted MCP claim until the shim exists.
2. After run 2, set the cadence for SharedNet and Concord. SharedNet has Release 1.0 on staging and a Decisions UI, but no Grok client and a plain HTTP join (U). Concord has a v0.16.0 release, a new installer, and Grok Build still listed (U). Options: stay weekly, go monthly, or drop. Recommendation: SharedNet monthly, Concord stays weekly because Grok Build is still listed and releases are frequent.
3. Read and test Concord's `concord check` and the standalone installer pattern as input for Sigil conflict hooks. Evidence is README text only (U). Recommendation: yes, as a read-only note with no code change this week.

Weekly competition PRs stay unmerged drafts until Chris decides or code is built.

## Sources that could not be read

- crosswalk/private: 404. (U)
- hyperagent/security: 404. (U)
- hyperagent/trust: 404. (U)
- agentrelay.com/pricing: 404. (U)
- kodama.run: 503. (U)
- Alook pricing amounts: page needs JavaScript and showed "Loading...". (U)
- Hyperagent changelog and rss: present, but only a truncated read was available. (U)
