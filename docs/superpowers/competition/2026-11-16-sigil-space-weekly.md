# Sigil space weekly analysis, 2026-11-16

Draft for review. Checked 2026-11-16 (scan run about 9:39 AM ET by run-weekly.sh). This is a diff against the 2026-11-09 weekly (PR #186): 656 diff lines across 46 changed files. Sigil facts are read from origin/main 0a82d4f.

Labels: (V) means seen in this week's fetched snapshot or in Sigil git history at 0a82d4f. (U) means unverified: not in a fetched snapshot body, inferred, or a vendor marketing count.

## Summary

- This was not a quiet week. Real changes showed up in the weekly targets. The scan excluded nav renames, footers, timestamps, CSS, build ids and rotating news teasers as noise. (V)
- New-entrant discovery did not run this week. At scan time, run-weekly.sh could not find the Grok CLI and wrote "grok CLI not available; discovery skipped". No substitute search was run. After the scan, Chris had the Grok CLI reinstalled on the box. Discovery was not re-run for this report. (V for the scan log)
- Crosswalk made the biggest move. It rebranded, added per-agent "telephone" numbers, opened public crosswalk creation, and added a one-click "Add to Grok Bot" button. (V)
- Hyperagent Rooms dropped the "Beta" label and renamed several docs sections. It moved its budget limit from per query to per turn. (V)
- Two monthly targets added Grok support plus approval features: polyroom and Harness Relay. After the scan, Chris moved both to weekly checks. (V for the product changes)
- Sigil shipped Phase 7 setup Tasks 4 to 6, release 0.2.3, and npm trusted publishing. (V)

## What changed since 2026-11-09

### Features

**Crosswalk**
- Rebranded as "private message boards for AI agents". (V, llms.txt and mcp.txt)
- New "telephone" feature: each agent gets its own 16-digit crosswalk number. The person chooses which crosswalks reach it. Another person's agent can message it at crosswalk.to/n/ once permitted. (V, llms.txt and mcp.txt)
- One-click "Add to ChatGPT / Add to Claude / Add to Grok Bot / Add to Muse" buttons appear on most pages. (V)
  - The home page says the ChatGPT add auto-adds to Codex and dots. (V)
  - It says the Claude add reaches Claude Code and Claude Duet. (V)
  - It says the Grok Bot add "auto-adds to Grok". (V)
- The developers page adds an "A2A to MCP bridge" guide. It covers Google ADK, Azure AI Foundry, Bedrock, Copilot Studio, CrewAI and LangGraph agents in one thread with Claude, ChatGPT and Codex. (V)
- The developers page also adds a guide to wake an agent from Exa Monitors webhooks. (V)
- New feature pages: to-do list, shared calendar, shared files for AI agents. The footer still says "Speaks MCP 2026-07-28 and A2A 1.0". (V)
- The repo jekajeka2/crosswalk.to went from 4 to 8 stars. (V)

**Hyperagent Rooms**
- The Rooms page no longer carries the "Beta" label. (V that the label is gone. U if this means general availability, since no announcement was read)
- Docs renamed: "Inbox" to "Approvals", "Autonomy" to "Permissions", "Invocations" to "Channels & automations". (V)
- New docs page: "Have your agents work together: let one agent ask another for help, control which agents can work together". (V)
- In a room, a named agent can post an update into another discussion. Room messages cited by an agent link to their source. Access still requires room and file access in the workspace. (V)
- Changelog, 2026-11-13: "Kimi K3.1 Pro and team usage". The index summary lists team usage by model and person, and source-linked room recaps. (V for title and summary. U for the entry body, not read)
- Changelog, 2026-11-12: "Shared connections, conversation comparisons and billing recovery". The index summary lists moving connections to a team and posting into existing room discussions. (V for title and summary. U for the entry body, not read)

**Concord MCP (Get-Concord-AI/concord-mcp)**
- v0.21.0 to v0.22.0 (2026-11-11). Stars 1006 to 1184. MIT. (V)
- The README adds OpenCode support. (V)
- inspect_work now shows "who is here" with three signals: heartbeat, last activity, and the status the agent reported. (V)
- inspect_work flags stale claims, an assignment nobody accepted, and in-progress work with no owning agent. (V)
- The supported list still includes Grok Build. (V)
- getconcord.ai adds a "Let your Claude Code talk to your teammate's Codex" connect guide. The stars badge shows 1.2K. (V)

**Switch Rooms (sandbox-quantum/switch, docs.switchagents.ai)**
- The README adds a "Switch Cloud" hosted option marked "Coming soon" beside self-hosting. (V)
- It adds "Switch Console" to talk to agents directly with no messaging app. (V)
- The agent list adds Antigravity, Cursor, OpenCode, and agents built with LangChain or ADK. (V)
- Connectors: Atlassian, GitHub, Datadog, Airtable. (V)
- Release tag v0.41.0-canary.10 (2026-11-16). Stars 4279 to 4536. (V)

**Block Buzz**
- Desktop release desktop-v0.5.28 to desktop-v0.5.30 (published 2026-11-13, 7:31 PM ET). Stars 36821 to 37511. (V)
- The README says the desktop app moved to a separate repo, block/buzz-app. (V)
- block/buzz now holds the relay and a new Flutter mobile client (mobile/), run in an iOS Simulator with "just mobile-dev". The README says "Single source of truth: the relay." (V)

**Other weekly targets**
- Alook: v0.1.66 to v0.1.69 (2026-11-13). Stars 1494 to 1512. The blog "Claude Code and Codex same team" was updated November 10 with official Codex plugin commands. The home page adds testimonials and "People and agents talk in the same channels" copy. This is marketing only. (V)
- Threadlines: latest 0.10.1 (November 13) "Linux fix". Nightly v0.10.2-nightly.20261116. Stars 45 to 47. (V)
- endue: the release index lists "2026.11.13 - One account across endue, an Eris you just talk to, and spaces improved around rooms and threads". (V for the title. U for details)
- Agent Relay (AgentWorkforce/relay): v17.2.1 to v18.8.0 (2026-11-15, 7:22 PM ET). Stars 1101 to 1121. README and site unchanged in the diff. (V)
- Reason Network: no new release. The latest tag is still v0.12.17 (2026-10-29 ET). Stars 1693 to 1769. Last push 2026-11-12. README unchanged in the diff. (V)
- SCP (scp.dev): the spec clarifies subagent threads in section 6.9. A subagent child thread's call binds to its root thread. Messages that reach a stopped child wait in its inbox. They are offered to the root to continue while the root has a live waker. (V)

### Pricing

- Hyperagent Rooms moved its budget limit from "per query" to "per turn". The page says it will "stop new model requests once a turn reaches the limit. Requests already in progress [may] exceed it, and paid tools are separate." It is set through Permissions -> Limits. (V)
- The Hyperagent manage page says "Dollar usage is not shown on the free tier." (V)
- Switch Rooms: workspace admins set usage budgets, choose which connectors are on, and control who has access. (V)
- Crosswalk home claims "12,069 agents connected this week", up from 9,314 in the 2026-11-09 snapshot. (V that the page says it. U that it is accurate, since it is a vendor marketing number)
- Agent Relay pricing page still returns 404. (V)

### License

- Switch Rooms: the license field reads NOASSERTION. (V)
- Alook stays Apache-2.0. Block Buzz is Apache-2.0. Threadlines is MIT. Concord MCP is MIT. Agent Relay is Apache-2.0. (V)
- Harness Relay (monthly target at scan time): the repo license field changed from Apache-2.0 to NOASSERTION. (V)

### Security claims

- Crosswalk's privacy policy was updated November 13, 2026. It adds "We may also scan links and files automatically for malware, phishing and spam." (V)
- Crosswalk's trust page now says Supabase holds sign-in, files and the Postgres database in AWS ca-central-1 (Montreal, Canada). (V)
- Crosswalk account deletion now has a "Delete account on crosswalk.to/me" button. (V)
- Crosswalk's new crosswalks are private unless asked for public. Public creation is open to any account, one at a time until two other accounts have posted in it. Before, creation was invite-only or by application. (V, README and data page)
- Hyperagent's integrations page says to connect an account, then allow the intended agent to use it. Hyperagent checks each request against the integration, its resource scope, and run permissions. (V)
- Hyperagent /security and /trust still return 404. (V)
- Reason Network's network page now shows "Backed by Y Combinator (F26)". The 2026-11-11 direction review already noted this. It is the first time in the weekly scan. (V)
- Switch Rooms removed this text from the docs landing page: "A new agent answers only its owner and the owner's other agents, until the owner chooses who else can give it work". (V that it is gone from that page. U if the rule changed)
- Switch Rooms docs nav adds "Switch Rooms shared responsibility" and "Switch Rooms working safely with agents". (U for content, not fetched)

### Grok Bot and MCP integrations

- Crosswalk adds "Add to Grok Bot" and says it "auto-adds to Grok". Its footer still says "Speaks MCP 2026-07-28 and A2A 1.0". (V)
- Concord MCP's supported list still includes Grok Build and adds OpenCode. (V)
- Switch Rooms adds Antigravity, Cursor and OpenCode to its agent list. (V)
- Crosswalk's A2A to MCP bridge guide spans Google ADK, Azure AI Foundry, Bedrock, Copilot Studio, CrewAI and LangGraph. (V)
- Adjacent, not a rooms competitor: Claude Managed Agents docs nav adds "Self-hosted Managed Agents" (Deploy on Kubernetes) and a HIPAA/ZDR data-handling row. (V)
- Adjacent: Slack CLI v4.14.0 has a changelog entry. A2A CLI docs moved to lessons, including "conversations, and credentials". (V)

### No material change

Plasma Radio (no diff), Portal (2 stars, no release, no license field), AgentCouch, Concord (fenginwind), SharedNet, AX (v0.8.2), mcp_agent_mail, RelayRoom, Murmur, acommune, Webex, and Teamily (no diff). (V)

OpenCouncil and Perplexity Projects pages are third-party news feeds, so noise. Zenzap build ids are noise. (V)

## Monthly targets

This is not the first Monday of the month. Monthly targets get a one-line flag only if they show a Grok or MCP integration or a security claim.

- Harness Relay: now supports twelve coding agents, including Grok, Antigravity, Copilot and Muse Code CLIs. A shell command beyond read-only waits for human approval. The license field changed from Apache-2.0 to NOASSERTION. Stars 8 to 33. (V)
- agent-chat (superint), rebranded "polyroom": works with Claude Code, Codex, ChatGPT, Claude.ai, Grok and other MCP clients. Decisions are approved by a per-room rule and recorded with who approved. Paid plan is $3 per agent per month. (V)
- Friday v0.2.26 (2026-11-15): the homepage dropped the "listens on 127.0.0.1 only and keeps its data on your computer" line. It now says it works with any agent that speaks the Agent Client Protocol. (V that the line is gone. U if the behavior changed)
- Globster: only "Download the Apps" for Mac and iPhone. No flag. Agent Room alpha.94. No flag. (V)

## New entrants

Discovery could not run this week. At scan time, the Grok CLI was not available on the box. run-weekly.sh wrote "grok CLI not available; discovery skipped". No substitute search was run, because the rule is no silent fallback when a routing CLI is missing. The report lists no new credible entrants this week. (V for the scan log)

After the scan, the Grok CLI was reinstalled on the box (version 1.0.77, set to grok-4.7). Discovery was not re-run for this report.

## Follow-ups on prior decisions

Status only, by reference to the 2026-11-09 decisions (PR #186). Nothing here is re-asked.

1. Globster monthly: applied in watchlist.json (cadence monthly). (V)
2. Switch Rooms and SCP weekly, other ten new projects monthly: applied in watchlist.json. (V)
3. Time-boxed Grok CLI turn-cancel test before any bridge code: no test doc or commit found on origin/main through 0a82d4f. Open. (V for absence in git log and docs grep)
4. Read-only note comparing Crosswalk A2A 1.0 with Sigil's message format: done, merged as PR #187 on 2026-11-10 (docs/superpowers/competition/2026-11-09-a2a-vs-sigil-envelope.md). (V)

The open questions from the 2026-11-11 direction review stay open and are not re-asked. Those questions are: (V)
- the target user for 90 days
- guest key custody
- one-link endpoint hostname
- CI re-run of the 848-schedule checker
- if star counts belong in the weekly

## Sigil this week

Read at origin/main 0a82d4f, git log since 2026-11-09. (V)

- Phase 7 setup Task 4 (#203, 2026-11-11): hidden collection, external paths, protected storage.
- Phase 7 setup Task 5 (#205, 2026-11-13): confirmed provisioning through sigil bot add.
- Phase 7 setup Task 6 (#209, 2026-11-15): entry point and phase sequencing.
- Reply-token status per bot (#210, 2026-11-16).
- Release 0.2.3 (#207, 2026-11-14). npm trusted publishing replaces NPM_TOKEN (#204). Release gate fixes (#208, #211).
- Earlier in this window: Tasks 1, 2, 3, 3A and 3A follow-ups (#190, #191, #193, #194, #195, 2026-11-11), the direction review (#192), and the A2A note (#187, 2026-11-10).
- Sigil still signs every envelope (Ed25519 over JCS). There is no one-link enrollment code and no Grok Bot MCP shim on main. This follows the 2026-11-11 review, and nothing since adds them. (V)
- No real Grok reply in a room is recorded on main. (U, no new STATUS entry read)

## What it means for Sigil

### Where Sigil leads

- Sigil signs every envelope with Ed25519 over JCS. (V, Sigil repo) This week's public snapshots do not show a competitor claim that matches that. (U for competitor internals, since only public pages were read)
- Sigil's rooms design already has a hop budget and a daily cost budget per room. (V, Sigil repo)

### Where Sigil is weaker

- Crosswalk now has a one-click "Add to Grok Bot" button, plus per-agent numbers that other people's agents can reach. This is the closest move yet to Sigil's cross-owner direct messages. Sigil has no one-link enrollment code and no Grok Bot MCP shim on main. This is context only. The existing one-link track covers it, and no new decision is proposed. (V)
- Crosswalk opened public creation for any account. Sigil's setup path is still in Phase 7 tasks. (V)
- Hyperagent dropped "Beta" from Rooms and has a docs section for letting one agent ask another for help. (V for the page. U for what it means as a release)
- Star counts show wide reach for Block Buzz (37511), Switch Rooms (4536) and Concord MCP (1184). The weekly's open question on if star counts belong stays open. (V)

### What to borrow

- A per-bot or per-turn cap is a possible small borrow. Sigil's rooms design has a hop budget (max_agent_turns, default 6) and a daily cost budget per room that switches the room to mentions-only (docs/superpowers/specs/2026-10-02-sigil-rooms-design.md and the room_budgets table). (V, Sigil repo)
- Hyperagent's per-turn model-request cap is similar in role. Switch's admin usage budgets are also similar in role. Hyperagent stops new model requests once a turn reaches the limit. (V)
- Concord MCP's "who is here" view uses three signals: heartbeat, last activity, and the agent's reported status. It also flags stale claims and unowned work. This could inform a Sigil presence view. (V for the Concord feature. U for fit)
- This is recorded as context. No decision is asked.

### What to ignore

- Alook testimonials and home copy. Marketing only. (V)
- Crosswalk's "12,069 agents connected this week" number. It is a vendor marketing number. (U)
- Harness Relay as a rooms model. It is a local desktop board, off-thesis per the 2026-11-11 review. Chris still moved it to weekly checks for its Grok support, approval gate and license change. (V for the review fact)
- Adjacent drift: Managed Agents self-hosting, Slack CLI, and A2A CLI docs. They are not rooms competitors. (V)

## Decisions made on 2026-11-16

Chris answered both questions after the scan, before this draft was written. Nothing here is re-asked.

**1. Discovery was blocked at scan time.** At about 9:39 AM ET, run-weekly.sh could not find the Grok CLI and wrote "grok CLI not available; discovery skipped". No fallback search was used. (V)

Chris chose to reinstall the Grok CLI so discovery can run again. The CLI is now installed on the box (version 1.0.77, set to grok-4.7). Discovery was not re-run for this week's report.

**2. Promote polyroom (superint) and Harness Relay from monthly to weekly.** Both added Grok support and approval or governance features this week. Polyroom added per-room decision approvals and a $3 per agent per month plan. Harness Relay added an approval gate before shell commands and changed its license field. (V)

The scan's recommendation was to promote polyroom only. It recommended keeping Harness Relay monthly, because it is a local desktop board and off-thesis per the 2026-11-11 review. It also said to note the license change.

Chris chose to move both to weekly checks.

This PR stays an unmerged draft until Chris reviews the write-up.

## Sources that could not be read

Fetch errors this week:
- crosswalk.to/private: 404
- hyperagent.com/security: 404
- hyperagent.com/trust: 404
- agentrelay.com/pricing: 404
- kodama.run: 503

Fetched, but body not read:
- Switch Rooms "shared responsibility" and "working safely with agents" pages: only their nav links appeared.
- Hyperagent changelog entry bodies: only titles and summaries on the index.
- endue 2026.11.13 release body: only the title line.
