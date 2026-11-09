# Sigil space weekly analysis, 2026-11-09

Draft for review. Checked 2026-11-09, as a diff against the 2026-10-26 weekly (PR #116, merged 2026-10-28). The 2026-11-02 scan did not run, so this report covers two weeks. The scan diff was 688 lines across 51 files. The watchlist added Globster as a core target and 12 discovered projects. (V) means the claim was read from a verified snapshot or from Sigil repo docs and git history, and (U) means it is secondary, marketing only with no extractable number, or from discovery notes outside a snapshot. Sigil facts come from origin/main ce605a7 and are (V).

## Summary

Reason Network moved the most. It shipped four releases after v0.12.13, passed 1693 stars, and now documents a click path for Grok Bot over MCP plus a desktop app join. (V) Crosswalk added A2A 1.0 beside MCP. (V) Concord MCP added a cloud mode and passed 1006 stars. (V) Globster entered as a core target but is a hosted single-assistant product, not a room or relay. (V) Twelve discovered projects joined the watchlist, and several ship Grok Build or Grok CLI inside a room. (V) The report proposes 4 new decisions.

## What changed since 2026-10-26

### Features

Reason Network went from v0.12.13 (2026-10-25) to v0.12.17 (published 2026-10-29, 9:50 PM ET). Releases v0.12.14 to v0.12.16 shipped 2026-10-29. (V)

- The README adds step-by-step guides for Grok Bot with Claude Code, Muse with Claude, and Codex with Claude Code. (V)
- The agent list adds Command Code. Native Antigravity conversations get an MCP config and native hooks, and a managed sidecar delivers messages through `agentapi send-message`, including while idle. (V)
- The tool list is `list_team`, `send_message`, `message_status` (new), and `ask_user` approve or deny. (V)
- `reason-network status --name <name>` lets a new session take an offline conversation's name and its unread mail on the same computer. Mail held for approval still needs approval. A six-hour startup grace rule applies. (V)
- Claude Code sessions auto-rename once to their conversation title. (V)
- Optional aggregate usage counters go to a local SQLite file. Per the README, reports carry agent families, delivery tiers, hook age and queue age, and no conversation ids. (V)

Crosswalk rewrote its home page. Agents can self-sign up with one curl POST to agents.crosswalk.to/signup. The SquadRoom page (updated 2026-11-04) offers a paste-a-prompt connect with a wake set by trigger URL, runtime wake endpoint, or A2A endpoint. The client list adds Buzz and DeepSeek Harness. (V)

Concord MCP went from v0.16.0 (2026-10-22) to v0.21.0 (2026-11-09). The README adds Concord Cloud, where `concord cloud login` links a machine so agents reach agents on other machines. It also adds global mode with `--repo-files`, plus Devin CLI and Conductor support. (V)

Agent Relay went from v14.0.0 (2026-10-13) to v17.2.1 (2026-11-07). Getting started is now `npx -y agent-relay@next init` in a project folder, and sessions join by themselves. With teammates, one person runs `init --hosted` and shares the printed `init --key` line. A paid desktop app adds shared sessions. (V)

Threadlines shipped v0.9.0 (2026-11-05) with nightlies to v0.9.1-nightly.20261107. The README adds "All your computers in one app" for Mac, Windows and Linux. An agent on one machine can start a thread on another after asking, unless allowed. It also adds a Fleet view, lets approved terminal agents start and follow threads, and adds scheduled and event tasks. (V)

Alook went from v0.1.59 (2026-10-25) to v0.1.66 (2026-11-09). Its agent table adds links for Cursor CLI, Pi, Grok (x.ai/build) and Antigravity CLI. (V)

Hyperagent's changelog for 2026-11-02 lists updates in a paired Messages chat, workspace-funded models, and team connections scope. The 2026-10-26 entry lists Rubrics and team usage. (V)

Concord (fenginwind) rewrote its home page with the hero "Independent agents. Shared purpose." Its Concord-agent CLI hosts Claude Code, Codex and Gemini, and other agents join over HTTP REST. (V)

AX moved from v0.8.1 to v0.8.2 (2026-11-07) with 8 stars. (V)

### Pricing

- Crosswalk SquadRoom still shows $49 on its page. (V)
- Endue lists Free (1 credit per week), Pro $15 per month, and Max $75 per month. (V)
- Hyperagent still lists a free allowance plus paid monthly credit plans. (V)
- Alook plan names are Free, Studio and House. The numbers render as "Loading..." in static HTML. (V for names, U for numbers)
- Reason Network pricing was not re-read this run, and the free status from 2026-10-26 is carried over. (U)
- Concord (fenginwind) FAQ says a Free plan exists. (V)
- Agent Relay pricing returned 404, so only the paid desktop app mention is known. (V for the README text, U for any price)
- Globster pricing is covered under new entrants.

### License

- Reason Network NOTICE says it is modified from tincan, under MIT or Apache-2.0 at your option. (V)
- Concord MCP stays MIT. (U)
- Threadlines describes itself as free and open source. (V)
- Switch Rooms shows license field NOASSERTION. Portal shows no license field. (V)

### Security claims

- Reason's envelope is unchanged: `Envelope{id: ulid, from, to, reply_to, thread, body, sent_at}` with no signature field. DESIGN still calls approvals a "speed bump". (V)
- Crosswalk's trust page says an A2A agent holds the same key or token as an MCP client. It adds that Crosswalk staff or Claude Code (its support agent) may open a specific post or message only for support or abuse cases. (V)
- Concord (fenginwind) FAQ says room messages and uploaded files are stored on the Concord server, and agents run on the user's machines with existing model access. It links a "Security model" page, which this run did not read. (V for the FAQ, U for the linked page)
- Hyperagent security and trust pages still return 404. (V)
- Globster security claims are covered under new entrants.

### Grok Bot and MCP integrations

- Reason's network page now says where to add the MCP URL in Grok Bot. The path is Bot settings, then MCP Servers, then Add a custom MCP. (V)
- The same page warns never to add the URL from a terminal or CLI on a cloud computer, such as the Grok CLI. That connection has no Reason sign-in, so every call is refused. Hosted MCP stays https://mcp.reasonmachines.com/mcp. (V)
- Reason also lets a user join from a Reason desktop app (Mac or web) with Google, GitHub, Apple or email sign-in. The paste line for AI agents is still offered. (V)
- Crosswalk's home lists Grok Bot. Threadlines lists Grok among supported agents. (V)
- Crosswalk's home claims "9,314 agents connected this week". That is the vendor's marketing number at snapshot time. (V that the page says it, U that the count is accurate)
- Sigil has no Grok Bot MCP shim and no one-paste join on main. (V)

### No material change

- Plasma Radio had nav and footer churn (11 hunks) and is still a link-joined channel for agents. (V)
- Block Buzz desktop-v0.5.28 is unchanged. Stars went from 36478 to 36821. (V)
- Portal has 2 stars, no releases, and no license field. (V)
- SharedNet had one small text hunk and still reads "Persistent Rooms where coding Agents talk". (V)
- AgentCouch was re-fetched with no line-item change called out. (U)
- Adjacent churn: Claude Managed Agents multiagent docs (mostly quote style and nav, plus an OpenTelemetry nav entry), OpenCouncil and Perplexity Projects secondary articles, Slack Code changelog drift, Zenzap docs, Teamily, Webex, and A2A CLI. None is a rooms or relay competitor. (V for drift, U for no material claim)

## New entrants

### Globster (new core target)

Globster's marketing brands the product "Rings AI", with the line "A Personal Assistant to Make You Shine at Work". It is backed by monday.com. The runtime is NVIDIA OpenShell on a Microsoft Cloud foundation. The same assistant answers in Slack, WhatsApp or Telegram, routes each task to a frontier model, and has its own browser for research with sources. (V)

The page claims 1,500+ app integrations, "1000s" of agents created, and "50K" tasks. These are the vendor's marketing claims at snapshot time. (V that the page says it, U that the counts are accurate)

The security page makes these claims. (V)

- Every hosted agent runs in its own sandbox behind the OpenShell boundary.
- Credential slots use encrypted storage with scoped access, so users do not paste keys into a chat.
- Configurable action approvals pause the agent for review.
- Organizations get budgets, operational audit logs, and approved plugins.
- Enterprise gets Okta SSO.

Pricing comes from the home page snapshot. (V)

- Personal shows $30 and $24 per month billed $288 per year.
- Team is $24 per seat per month billed annually, from 3 seats, with an admin console, usage tiers and shared top-ups.
- Enterprise is custom, with Okta SSO, app and channel policies, approval settings for everyone, and member budgets.
- Usage levels are Standard, 2x and 4x.
- The page says "Start free. No credit card needed." A startup program gives 2 months free.

app.globster.ai and its pricing page returned 200 but are JavaScript shells with only the title "Globster | One-click AI agents". (V for the title.) No mention of Grok, MCP, multi-agent rooms or a license was found in the snapshot text. (U for the absence)

Assessment: Globster is a hosted single-assistant-per-person product with org controls. It is not an agent-to-agent room or relay. Its overlap with Sigil is approvals, budgets, audit logs and chat-channel presence, not transport. (U, assessment from the evidence)

### Newly discovered projects

Twelve projects entered at the discovered tier. All 12 URLs returned 200. Repo stats come from saved repo API snapshots (V). Discovery-note dates and posts are (U).

| Name | What it is | Signal | Label |
|---|---|---|---|
| SCP (scp.dev) | Protocol spec v1 for messages between Claude Code, Codex, OpenCode, pi, Muse, Agy and Grok at turn boundaries, with wake for hibernated sessions | Hub joins two accounts across machines as contacts, optional judge | (V) |
| Switch Rooms (switchagents.ai) | Slack, Teams, Discord, Telegram and Mattermost channels become rooms for people plus Claude Code, Codex, OpenCode, Cursor and Antigravity | 4279 stars, pushed 2026-11-09, license NOASSERTION | (V) for stars, (U) for the hackathon 2026-11-04 to 2026-11-07 |
| Friday (tryfridaywork.com) | Local board where Claude Code, Codex, Cursor, Grok Build and OpenCode message and split work | 60 stars, MIT, created 2026-10-26, releases to v0.2.19 (2026-11-08) | (V) |
| agent-chat (superint.ai) | Cloud rooms for a team and their Claude Code, Codex and MCP agents, with a human yes per room | Plugin repo created 2026-10-23 | (V) for the page, (U) for the launch post |
| Agent Room (agentroom.chat) | Matrix rooms for humans plus Claude Code and Codex across machines | 17 stars, alpha.93 on 2026-11-09 | (V) |
| Harness Relay | Local group chat for real Claude Code, Codex and Grok CLIs with roles and turn order | 8 stars, created 2026-11-07 | (V) |
| Peertable | Peer round-table rooms, no orchestrator | 0 stars | (V) |
| PeerBridge MCP | Local auditable multi-agent control room | 239 stars, Apache-2.0, last release alpha.6 on 2026-09-02, missed by earlier scans | (V) |
| agentroom (@sauerapple/agentroom) | Ephemeral end-to-end encrypted MCP rooms, with a room code like ar1_... that expires in 24h | Default relay is a public Cloudflare instance, 0 stars, Apache-2.0, early 0.2.x | (V) |
| Scranton | Local Mac Slack-style channels with @mention wake for Claude Code, Codex and Cursor | Created 2026-11-07 | (V) |
| Hellhound (Microsoft Store) | Windows app with Claude Code, Codex and Grok Build in one room, @order and turn-taking mode | Store page read | (V) for the store page, (U) for the v1.3.0 and Grok Build add dates |
| room-chat-ai | Browser rooms with server-side turns and @Name routing for Claude Code, Codex and Antigravity | Server-side turns | (V) |

Switch Rooms is the most notable because 4279 stars is the largest count among the new entrants and it puts rooms inside chat tools people already use. (V) SCP is the other, because it is a protocol with Grok support, wake, and a cross-account hub, which overlaps Sigil's cross-owner design. (V)

At least five new entrants name Grok Build or Grok CLI as a supported agent. SCP, Friday, Harness Relay and Hellhound pages say so (V). PairRoom, from the weak list, is the fifth (U).

Weak leftovers were recorded but not watched: Herdr Group Chat, Prakshal agent-bridge, stoops-cli, RLabs agent-chat-mcp, NexusRelay, Code Room, PairRoom, agents-room, Agent Rooms, py-redis-agent-chatroom, MAO, Defleet, and nexscope (404). (U)

## Follow-ups on prior decisions

Status only.

- PR #71 (2026-10-18): all 7 approved as written. No open items. (V)
- PR #73 (2026-10-19):
  1. Other owners' agents hold, not refuse, by default. Approved. The hybrid design is written but not fully built. Doc lag remains: hybrid-dm-decisions.md on origin/main still says "Cross-owner default remains undecided" for Q2. This is doc lag, not a new decision.
  2. WebAuthn approval as a signed verifiable record before signed HALT was approved as read-and-test. No completion report was seen on main.
  3. AgentCouch stays a core weekly target.
  4. The Grok Bot MCP shim stays Grok Bot over MCP only. Grok CLI hooks are logged as a follow-up. The shim is not built. (V)
- PR #116 (2026-10-26, merged 2026-10-28, merged as written with no review comments recorded, treated as approved):
  1. The one-paste join spike for local agents, time-boxed: no spike commit or doc was found on origin/main through ce605a7.
  2. SharedNet monthly, Concord stays weekly: applied. SharedNet showed one small text hunk this run.
  3. The read-only note on Concord `concord check` and the standalone installer for Sigil conflict hooks: no note was found on origin/main. The Concord README this run adds global mode and `--repo-files`, which is input for that note. (V)
- Older: Hyperagent message edit details are still open. (U) Reason CLI terms are still unknown. (U)
- tincan: still Sigil-local Tailscale tsnet. The Reason NOTICE says Reason Network was originally developed as tincan (larstalian/tincan) and modified. There is no interop and the prior decision stands. (V for Sigil, V for the NOTICE text)
- Phase 7 endpoint setup: Chris declined it. Reply ingress is built and merged, and the live transport smoke passed 2026-10-20 at about 10:23 PM ET through a Cloudflare named tunnel and Access service-token policy. The proof bar is still open: a real Grok reply landing in a room, then 7 days with no incidents. This is status only. (V)

## What it means for Sigil

### Where Sigil leads

- Sigil signs every envelope. Reason's envelope has no signature field. (V)
- The relay rejects a reused message_id, and rooms have a governed roster. (V)
- Phase 7 reply ingress is proven live over a Cloudflare named tunnel. (V)
- A TLA+ model covers room message delivery to Floor Warden bots, and room bridge formal verification is on main. (V)
- Sigil now has an OS credential store adapter, secret-free launch, and `sigil service install|start|stop|status|uninstall` for Windows Task Scheduler and Linux systemd user units. (V)
- Globster claims approvals and audit logs, but for one assistant, not between agents of different owners. (V for the Globster claims, U for the comparison)

### Where Sigil is weaker

- Reason documents a click path for Grok Bot MCP and a desktop app join. Sigil has neither. (V)
- Reason has 1693 stars and shipped four releases on 2026-10-29. Concord MCP has 1006 stars and went from v0.16.0 to v0.21.0 in 18 days. Switch Rooms has 4279 stars. Sigil has no matching public traction signal in the repo docs. (V)
- Several entrants ship Grok CLI in a room while Sigil defers its bridge. (V)
- Concord Cloud links a machine with `concord cloud login`, Agent Relay shares one `init --key` line, and Crosswalk signs an agent up with one curl POST. Sigil has no one-paste join on main. (V)

### What to borrow

- Reason name reclaim with mail handoff and the held-mail rule. (V)
- Reason `message_status` tool. (V)
- The Agent Relay `init --key` line and the agentroom ar1 code with 24h expiry, as input for the approved one-paste join spike. (V)
- Globster approval pause, member budgets, and audit log presentation. (V)
- Threadlines cross-machine thread start with the ask-first rule. (V)
- Concord global mode with `--repo-files`, for the approved conflict-hook note. (V)

### What to ignore

- Crosswalk "agents connected this week" and board counts. These are vendor marketing numbers. (U)
- Alook footer and Download link. (V)
- Hyperagent Messages chat pairing, for Sigil product choices. (V)
- Plasma page churn and Claude Managed Agents doc churn. (V)
- Globster usage tier pricing, for Sigil product choices. Sigil is unpriced. (V)

## Proposed decisions

1. Globster tier. It was added as core but is a hosted single-assistant product, not a room or relay. Options are keep core weekly, move to adjacent monthly, or drop. Recommendation: move to adjacent monthly, and keep reading its approvals, budgets and audit log pages as a borrow source.
2. Promote discovered projects. Recommendation: promote Switch Rooms (4279 stars, chat-channel rooms) and SCP (protocol with Grok, wake, cross-account hub) to weekly watch, and keep the other ten as discovered with a monthly recheck.
3. Grok CLI bridge priority. Several new entrants ship Grok Build or Grok CLI in a room, and Sigil defers it pending cancellation evidence. Options are keep deferred, or schedule the cancellation-evidence spike now. Recommendation: schedule a time-boxed read-and-test of Grok CLI turn cancellation, with no bridge code until it passes.
4. A2A note. Crosswalk now speaks A2A 1.0 beside MCP. Recommendation: write a read-only comparison note of A2A agent cards and push config against Sigil envelopes, with no code.

This PR stays an unmerged draft until Chris decides or code is built.

## Sources that could not be read

- crosswalk.to/private returned 404. (V)
- hyperagent.com/security returned 404. (V)
- hyperagent.com/trust returned 404. (V)
- agentrelay.com/pricing returned 404. (V)
- kodama.run returned 503. (V)
- app.globster.ai and app.globster.ai/pricing returned 200 but are JavaScript shells with only a title. (V)
- Alook pricing numbers render "Loading..." in static HTML. (V)
- Concord (fenginwind) "Security model" page was linked but not read. (U)
- nexscope returned 404 during discovery. (U)
