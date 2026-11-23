# Sigil space weekly analysis, 2026-11-23

Draft for review. Checked 2026-11-23 (scan run by run-weekly.sh). This is a diff against the 2026-11-16 weekly (PR #213, merged 2026-11-16 at 5:08 PM ET). The snapshot diff is 60 changed pages. Sigil facts are read from origin/main 53223d0 (2026-11-22, 10:33 PM ET). The newest SemVer tag seen on origin is still v0.2.3. git describe reports v0.2.1-1022-g53223d0. Release tags also include v0.2.3-retry.5.

Labels: (V) means seen in this week's fetched snapshot, including repo-api.json and releases.json, or in Sigil git history at 53223d0. (U) means not in a fetched snapshot body, inferred, a vendor marketing count, or taken from discovery-2026-11-23.txt. Discovery pages were not re-fetched into snapshots.

## Summary

- Crosswalk is the main product move. The home page now frames work across owners. Terms make approval of each outbound email opt-in. Privacy, terms, and trust describe automated analysis of content, private crosswalks included. Tables are a new data type. (V)
- Reason Network changed the Grok Bot connector path to the desktop app. DESIGN.md adds an app-through-Reason delivery path and a machine host-name field. The latest tag is still v0.12.17. (V)
- Switch Rooms rewrote its marketing page around Rooms, Trust, ROI, Switch Collab, and Scan & Eval CLI. The README admin sentence no longer includes usage budgets. Stars 4536 to 4696. (V)
- polyroom's plugin repo now says polyroom. The plugin creates the agent, and the person approves it with a one-time code. Claude Code sessions start listening on open. (V)
- Harness Relay's repo description now says a lead agent designs a team, the person confirms, and the agents work on that machine. The weekly cadence set on 2026-11-16 stays. (V)
- endue cut Free weekly credits from 1 to 0.25. Listed prices stay Free, Pro $15, Max $75, and Ultra $600. (V)
- On main since PR #213, Sigil merged the Phase 7 runbook and room-bot docs, the rewritelabs.io relay domain, AG-UI projection with an approval drift guard, and approval challenges bound to the signed envelope. (V)
- Discovery lists thirteen names that are not on the watchlist. Every discovery line is (U). Crosswalk's alternatives page also names Vercel Board. That mention is (V).

## What changed since 2026-11-16

### Features

**Crosswalk**
- The home heading is "you and your agents". The demo shows Instinct, Claude Code, Muse, and Grok Bot posting on one board, then "You reply". (V)
- The feature list is still Messages, Inbox, Tasks, Files, Calendar, and Rules, numbered 01 to 06. (V)
- Use cases now start with Second opinion, Small business, Teammates, and Client work. (V)
- Tables are a new data type. A row is something an agent puts in a crosswalk table, with who added it and when, plus rules and actions. Cloudflare holds those rows, one database per crosswalk. (V)
- The developers page adds a note on a "Pilot first" block that Pilot Protocol's daemon writes into CLAUDE.md, AGENTS.md, or SOUL.md, and how to remove it. (V)
- MCP 2026-07-28, A2A 1.0, telephone numbers, and Add to Grok Bot were already recorded on 2026-11-16. The new footer line in the compact diff is cut off before those phrases, so they are not repeated here. (V)

**Hyperagent**
- llms.txt adds a guide titled "Find and reuse Library items", and an Agencies section. The client-work guide says to decide who can change the agents, who pays for runs, and who maintains the setup before client work goes live. (V)
- The schedules blurb now says a run can be one-off or recurring, and that the person chooses what each run can change and where the result belongs. (V)
- The integrations page says to choose Create a skill or Request an integration from search results. Add custom MCP server appears there when it is available. (V)
- Rooms and plans hunks in the pack are near-empty. /security and /trust still return 404. The changelog index hunk shows nav text, and no new entry title. (V)

**Switch Rooms**
- The marketing page groups the family as Rooms, Trust, ROI, and open source Switch Collab and Scan & Eval CLI. The hero says people and agents from any vendor work as one team in Slack or Teams. (V)
- The README demo now says an agent finds the deploy, a second agent confirms the error rate, and a rollback happens once a person approves. A Microsoft Teams block was added. (V)
- The admin sentence now says workspace admins choose connectors and who has access. The removed clause said they set usage budgets. Guardrails and cost reporting still come with Switch Trust and Switch ROI. (V that the sentence changed. U if budgets remain on another page)
- The repo description now names Claude Code, Codex, Gemini (Antigravity), Cursor, GitHub Copilot, MCP, and connectors for GitHub, Jira, Notion, Linear, and Google Workspace. (V)
- The rooms docs snapshot shows no clear body change. Shared-responsibility and working-safely pages are still nav links only. (V)
- The latest listed tag moved from v0.41.0-canary.10 to a prerelease stream named switch-agent-controller-v0.32.2-dev.* (example v0.32.2-dev.649.g3b503b5 at 2026-11-23, 5:51 AM ET). The repo publishes more than one tag stream. Those names are not a product version drop from 0.41 to 0.32. (V)

**polyroom**
- The site text calls polyroom a shared workspace for agents and the team, with rooms, boards, and approvals for decisions that need a person. (V)
- The README now says polyroom plugins, marketplace superint-ai/polyroom-plugins, and install name polyroom@superint. The MCP URL is https://mcp.polyroom.ai/mcp. (V)
- Claude Code starts listening when the session opens. Codex still needs "Listen to polyroom" in each conversation. (V)
- The plugin creates the agent after sign-in. The person approves it in polyroom with a one-time code. The previous text required the agent to exist first, and an owner or admin role. The Claude Code plugin needs Node.js 18 or newer. (V)
- OpenClaw and Hermes Agent connect with the server URL and an agent token. A wake worker on the same computer as their gateway answers mentions. (V)

**Harness Relay**
- The repo description now says one kind of agent is enough for a team, or a person can mix any of twelve coding agents, such as Claude Code, Codex, and Grok. The lead agent designs a team for each question. Once the person confirms, the agents work on the code, or on any question, on that machine. (V)
- The 2026-11-16 weekly set Harness Relay aside as a rooms model. It remains a local desktop assistant, off-thesis per the 2026-11-11 review. Weekly checks stay for Grok, the confirm step, and the license field. License is still NOASSERTION. (V)
- The compact diff does not include the Harness Relay page hunks. No further product list is taken from those pages. (U for anything only in the uncopied hunks)

**Reason Network**
- The README is unchanged. The latest release tag is still v0.12.17. (V)
- DESIGN.md adds "App connected through Reason". Hooks are marked through_reason. Senders of wake mail get queued, and they do not get delivered. The person's own Reason sessions still get mail through `reason session send`. (V)
- DESIGN.md adds a machine field, the computer's host name, set when it creates or joins a team. REASON_NETWORK_MACHINE overrides it. (V)

**Agent Relay**
- The README install lines now use `npx -y agent-relay`. The hosted team flow is `npx -y agent-relay init --hosted`. The previous lines used agent-relay@next. (V)
- The self-hosting guide link now points at https://agentrelay.com/docs/self-hosting. The README adds https://github.com/AgentWorkforce/infra for helm charts and terraform. (V)
- No release-note body for v18.10.0, v18.11.0, or v18.12.0 is in the pack. (V for the tags. U for changes inside those tags)

**Alook**
- The home page adds "Discord for humans and agents" and a "Ways people use Alook" list. The list includes asking a teammate's agent, pairing two agents overnight, and running across computers. (V)
- The README adds "Install Node.js >= 22.12 before running the public Alook App or daemon package." (V)
- The blog diff is large and reads as template or nav churn. The pricing nav label changed from Tutorials to Use Cases. Static HTML still has no price numbers. (V)

**SCP**
- scp.docs.txt is identical. scp.spec.txt has 34 hunks at ratio 0.985, a small change in a large spec. (V)
- A newer tool connection of the same session supersedes the older one. The older connection receives superseded and the endpoint it held, must stop, must refuse its tools with code superseded, and must not reconnect. (V)
- hello accepts instance on a claim or a resume. instance is that process's own id, at most 128 characters, and it must start with a letter or digit. (V)
- A connecting claim that names another session does not join that endpoint. Handback now includes stderr when the worker left no output, and also after a non-zero exit. (V)
- An exact claim with under can re-home a root that only exact claims held, under the conditions in section 6.8. The event name is claim_rehome. A new error code is superseded. (V)

### Pricing

- endue Free weekly credits changed from 1 to 0.25 on the pricing grid. Pro stays $15, Max stays $75, and Ultra stays $600. SSO and SLA remain on Ultra. In the compare row, Pro, Max, and Ultra stay at 3.75, 18.75, and 150 weekly credits. (V)
- Crosswalk's SquadRoom pricing page reshuffled the agent list and added Viktor. The alternatives count on that page went from 8 to 9. No dollar amount changed in the diff. (V)
- agentrelay.com/pricing still returns 404. (V)

### Security claims

- Crosswalk privacy and terms are last updated November 22, 2026. Privacy was November 13. Terms were November 3. (V)
- Privacy, terms, and trust now say use is analyzed across all crosswalks, private ones included. The text says the analysis is automated and is read as counts and patterns. It says this can cover what posts, tasks, and files contain, and that nobody reads private posts for this purpose. (V)
- Trust usage analytics now say they record which tool an account called and from which client, "never what a post says". The previous line said "never post content". The page points content counts at the section on who can read what. (V)
- Email from the crosswalk address can still be limited or revoked. Agents send when the person asks or when the work calls for it. To approve each message first, the person turns that on in Settings or tells an agent. The previous terms required approval of the exact text before each send. (V)
- Account deletion still offers erase, or anonymize as "[former member]". Rows that person added to tables in other crosswalks follow the same choice, within the hour. A deleted crosswalk's tables are wiped within the hour. (V)
- Hyperagent's integrations page replaced the line that said credentials stay outside the run and that agent scripts cannot read, copy, or forward them. The new text says to authorize connected apps and custom MCP servers in their connection flows, choose which agent can use the account, keep API skill credentials in their own settings, and not paste secrets into a thread. (V that the sentences changed. U if the check changed)
- Agent Room (rainyflash, monthly): the README says a public room that starts public is not encrypted, a private room later made public stays encrypted, and a project room linked to GitHub is public and not encrypted. Release v0.1.0-alpha.101, 2026-11-21 at 11:14 AM ET. Stars 20 to 23. (V)
- Friday (monthly) shipped v0.4.0 on 2026-11-20 at 5:09 PM ET. Stars 67 to 85. The compact README hunk adds Pi and shows no Grok, MCP, or security-claim change. (V for that hunk. U for the marketing page, which is not in the compact diff)

### Grok Bot or MCP integrations

- Reason Network's network page changed the Grok Bot path. The old text was Bot settings, then MCP Servers, then Add a custom MCP. The new text is: in the desktop app, Connect apps, Add a custom connector, type Remote HTTPS. (V)
- polyroom's README MCP host is now https://mcp.polyroom.ai/mcp. OpenClaw and Hermes Agent connect with a server URL and an agent token. (V)
- Switch Rooms' repo description names MCP and the connectors listed under Features. (V)
- AX 0.8.3 restores Codex messaging after MCP reconnects, keeps Claude readiness during compaction, and shows mailbox backlog and delivery holds in agent discovery. Failed sends separate a definite refusal from an uncertain outcome. Published 2026-11-20 at 3:38 AM ET. Stars stay 8. MIT. (V)
- Crosswalk's home demo shows Grok Bot on the board. Add to Grok Bot was already recorded on 2026-11-16. (V)
- Harness Relay's new description names Grok among the twelve agents. (V)

### Reach (stars, releases)

Stars and releases below are GitHub API snapshots. Times are America/New_York. (V)

- Alook (alookai/alook): 1512 to 1533. Apache-2.0 unchanged. v0.1.69 to v0.1.71, published 2026-11-21 at 12:02 PM ET. v0.1.70 was 2026-11-18 at 3:32 AM ET.
- Crosswalk (jekajeka2/crosswalk.to): 8 to 9. License none. No releases.
- Reason Network (reason-machines/reason-network): 1769 to 1812. Apache-2.0. No new tag. Latest remains v0.12.17.
- Threadlines: 47 to 50. MIT. Nightly moved from v0.10.2-nightly.20261116.387 to v0.11.0-nightly.20261120.394, a prerelease. No Threadlines marketing hunk is in the compact diff.
- Agent Relay (AgentWorkforce/relay): 1121 to 1146. Apache-2.0. v18.8.0 to v18.12.0, published 2026-11-21 at 10:37 AM ET. Also v18.11.0 (2026-11-19) and v18.10.0 (2026-11-17).
- Concord MCP (Get-Concord-AI/concord-mcp): 1184 to 1507. MIT. v0.22.0 to v0.23.0, published 2026-11-17 at 5:46 AM ET. The getconcord.ai hunk shows no readable product change. No v0.23.0 release-note body is in the pack. (U for what the tag contains)
- Block Buzz: 37511 to 37689. Apache-2.0. Latest release still desktop-v0.5.30.
- Harness Relay: 33 to 41. License still NOASSERTION. Release name 2026-11-23, published 2026-11-23 at 8:46 AM ET, plus 2026-11-23-rc and 2026-11-22.1.
- mcp_agent_mail: 2235 to 2242. License NOASSERTION. v0.3.2 to v0.3.5, published 2026-11-22 at 4:25 AM ET. No README hunk is in the compact diff.
- polyroom (superint-ai/polyroom-plugins): 0 to 1. MIT. No GitHub release tags.
- Switch Rooms (sandbox-quantum/switch): 4536 to 4696. License still NOASSERTION.

Repos with unchanged stars and no material page change are omitted. Friday and Agent Room (rainyflash) are in Security claims.

## New entrants

Discovery ran. Each line below was checked against a repo README or a product page during that pass. This analysis did not re-fetch those pages into snapshots. Every capability line is (U).

1. Pepper, https://pepper.vycari.ai. Rooms a person sits in. An agent gets its own name and token and posts through the Pepper CLI, including Claude Code and Codex. (U)
2. bot-link, https://github.com/charles161/botlink. A room for one person's agent and someone else's (Claude Code, Codex, Cursor). Each message is sealed on the sender's machine. A person approves every chat that joins. (U)
3. Vercel Board, https://vercel.com/docs/board. Channels and threads for people and coding agents, with verified authors, @mentions, and grants for who can post. Discovery says the public launch was 2026-11-18. That date is (U). Crosswalk's alternatives page now names Vercel Board, as a board for a Vercel team's coding agents, set next to Crosswalk where "every agent reaches". The Crosswalk mention is (V). Vercel Board's own behavior is (U).
4. Agentes.chat, https://agentes.chat. Self-hosted Slack-style channels and DMs for a team and agents. Discovery says the repo opened 2026-11-09. (U)
5. AIChatLink, https://github.com/aiyao3923-blip/AIChatLink. A local room that routes one conversation to Codex, Grok, Claude Code, pi, and WorkBuddy. (U)
6. Agent Rooms for Obsidian, https://github.com/arminayat/obsidian-agent-rooms. Rooms are Markdown files. A relay wakes Claude Code, Codex, or Hermes when a message is for them. A post can be signed in the plugin. (U)
7. AGI, https://github.com/compoodment/agent-group-interface. Local terminal group chat for a person, Claude Code, and Codex. (U)
8. Agent Room (lemoncube7), https://github.com/lemoncube7/agent-room-local. Local Windows chat room. Codex and Claude Code join. The browser is where a person approves who joins. (U)
9. AgentRoom (Litt-R), https://github.com/Litt-R/AgentRoom. Local multi-room desktop chat for Codex and Claude Code. The person mentions a member to hand work, and accepts the result. (U)
10. Harmonia, https://github.com/ShaharIlany/harmonia. Mac channels where Claude Code teammates talk, hand work with @mentions, and the person approves permissions from cards in the chat. (U)
11. Goblin Launcher, https://github.com/pacwestnobody/goblin-launcher. Self-hosted room with agent seats, including Claude Code and Grok Build, and phone approvals. (U)
12. ZumiBot, https://github.com/MhdAljuboori/ZumiBot. Group chats with Claude Code agents, in the browser, against a server the person hosts. (U)
13. Claude multi-agent chat, https://github.com/dextermb/claude-mutli-agent-chat. Local DMs, group chats, and channels of headless Claude Code agents. An @mention starts that agent's turn. (U)

WEAK, and not shared-room competitors, all (U). Leave them off the watchlist: agentbridge, agent-bus, agent-room (skep13), Claude Rooms (dbenson457), claude-control-room (kimjiwoon), control-room (MedianAura), AI Command Centre, ai-team, AgentsRoom (agentsroom.dev).

## Follow-ups on prior decisions

Status only. Nothing here is re-asked.

1. PR #186, Globster monthly: applied in watchlist.json. (V)
2. PR #186, Switch Rooms and SCP weekly: applied. The other names from that promotion round stay monthly, except polyroom and Harness Relay. (V)
3. PR #213, polyroom and Harness Relay weekly: applied on 2026-11-16. This week's product notes are above. Cadence stays as set. (V)
4. PR #187, read-only A2A 1.0 note against Sigil's envelope: on main since 2026-11-10. (V)
5. PR #186, time-boxed Grok CLI turn-cancel test before any bridge code: no completion report or test doc was found on origin/main through 53223d0 outside the weekly and competition write-ups and older bridge plans. Still open. (V for that search)
6. Grok Bot MCP shim: still absent as a shipped feature in the docs and code searched for this pack. No new shim doc. (V for that search)
7. PR #116 and #73 items still open as of the 2026-11-16 weekly: one-paste join was not seen as a landed feature. The hybrid rooms and direct-message design is written and not fully built. A WebAuthn-as-signed-record completion report was not seen. A Concord `concord check` note was not seen as a new doc. No later commit in the collected main history shows any of those landing. Not seen on origin/main through 53223d0. (V for that search)
8. Phase 7 proof bar from earlier weeklies: a real Grok reply in a room, then 7 days with no incidents. The 2026-11-16 weekly left it open. This pack has no STATUS entry that closes it. Still open. (U)
9. Whether star counts belong in the weekly was left open on 2026-11-16. Not re-asked. This week's deltas are reported above as facts. (V)

## Sigil this week

Read at origin/main 53223d0, since PR #213 (2026-11-16, 5:08 PM ET). (V)

- Phase 7: setup runbook (#226), registry-refresh probe fix (#225), bot-add registry race fix (#229), reply tokens rejected after expires_at (#215), Windows `sigil service` can replace the stack launcher (#235), relay domain on rewritelabs.io (#232), docs for the #219 cutover and Phase 7 room bots going live (#233).
- AG-UI: projection of relay facts to AG-UI events (#242, #248), SSE route for runs (#243, #279), approval drift guard (#245, #280), TLA+ job for ag-ui-approval (#251), protocol version and resume docs (#246), projection design (#236).
- Approvals: the challenge is bound to the signed envelope it approves (#239). A high-risk retry returns the original acceptance (#238). Cancellation of approval challenges is atomic (#247).
- Rooms web: sender chips with a human or agent mark and an acting-for line (#275). Bounded history and search (#281, #282). Redesign plan and live walkthrough docs (#250, #252).
- Also in this window: isolated kb-sync connector service (#237, #278), docs-only pre-push skip (#214), Astryx dual-interface architecture and schema work (#249), npm trusted-publishing path fixes (#222, #223).
- Sigil still signs every envelope (Ed25519 over JCS). The rooms design still has a hop budget and a daily cost budget. Reply ingress was already proven before this window. No one-link enrollment code and no Grok Bot MCP shim were found on main through 53223d0. (V)

## What it means for Sigil

### Where Sigil leads

- Sigil signs every envelope with Ed25519 over JCS. This week the approval challenge is bound to the signed envelope it approves, a high-risk retry returns the original acceptance, and cancellation of those challenges is atomic. (V)
- AG-UI work on main projects relay facts to AG-UI events, adds an SSE route for runs, adds an approval drift guard, and adds a TLA+ job for ag-ui-approval. No competitor snapshot in this pack states a model-checked approval rule. (V for the merges. U for competitor pages)
- The rooms design still has a hop budget and a daily cost budget. Switch Rooms' README dropped the admin usage-budget clause from the sentence quoted above. (V)
- Phase 7 docs record room bots going live, and the relay domain is on rewritelabs.io. Reply ingress was already proven. The 7-day incident-free bar is still open. (V for the merges. U for the open bar)

### Where Sigil is weaker

- Reason Network documents a Grok Bot path a person can follow in the desktop app. Sigil has no Grok Bot MCP shim on main through 53223d0. The Grok tracks are already decided. No new decision. (V)
- Crosswalk's new use cases are work across owners: a second opinion, a partner's agent, a teammate's agent, and client work. Sigil's hybrid direct-message design is written and not fully built. One-link enrollment was not seen on main through 53223d0. (V)
- Crosswalk's shipped terms make per-message email approval opt-in. Sigil's direct-message design holds a message until `sigil dm release` or `sigil dm refuse`. The phase 7 tunnel design keeps direct messages off the reply ingress. This pack does not show Sigil's shipped default for that path. (V for the Crosswalk terms and the design files. U for the shipped default)
- polyroom creates the agent from the plugin and approves it with a one-time code, and Claude Code listens when the session opens. Sigil's one-paste join spike was not seen as landed. (V)

### What to borrow

- AX 0.8.3 separates a definite refusal from an uncertain send, and it shows backlog and delivery holds in discovery. Sigil's direct-message design names held and refused. It does not name an uncertain outcome. No decision. (V for AX. U for fit)
- polyroom's one-time code, after the plugin creates the agent, sits next to the one-paste join spike. That spike is already approved. Not re-asked. (V)
- Crosswalk's Tables type records who added a row and when, and deletion follows erase or "[former member]" within the hour. The hybrid and phase 7 design files in this pack do not describe a shared table type. No decision. (V)

### What to ignore

- Crosswalk's "15,394 agents connected this week", up from "12,069" on the 2026-11-16 snapshot. The page says it. The number is vendor marketing. (V that the page says it. U for accuracy)
- Crosswalk README board-count churn, including to/q9quota. The README describes that row as a disposable synthetic test board, operator-authorized 2026-11-17, with no real content. Board counts stay marketing numbers. (V for the row text. U for the counts)
- Alook home copy, blog churn, and the Tutorials to Use Cases nav rename. The Node.js 22.12 line is the README change reported above. (V)
- Harness Relay as a rooms model. The confirm step is part of the local desktop flow the 2026-11-16 weekly set aside. (V)
- The WEAK names listed above. (U)

## Proposed decisions

1. Add Vercel Board to the weekly watchlist. Recommendation: yes. Crosswalk's alternatives page now names it, and that mention is (V). The docs URL is stable enough for the next scan to fetch. Discovery's launch date and the grants, @mentions, and verified-author claims stay (U) until a snapshot exists.

2. Add Pepper and bot-link at monthly. Recommendation: yes. Pepper is a room a person sits in, with a per-agent name and token. bot-link seals each message on the sender's machine and requires a person to approve every chat that joins. Both are (U) until a snapshot exists. Monthly matches the 2026-11-09 placement for new names that do not yet have a weekly product diff. Leave the other discovery names off: Agentes.chat, AIChatLink, Agent Rooms for Obsidian, AGI, Agent Room (lemoncube7), AgentRoom (Litt-R), Harmonia, Goblin Launcher, ZumiBot, and Claude multi-agent chat. Goblin Launcher's discovery line names Grok Build and phone approvals. That page was not snapshotted, so Goblin Launcher stays off this week. Leave every WEAK name off.

This PR stays an unmerged draft until Chris reviews it.

## Sources that could not be read

Fetch errors, the same set as the 2026-11-16 weekly (V):
- crosswalk.to/private: 404
- hyperagent.com/security: 404
- hyperagent.com/trust: 404
- agentrelay.com/pricing: 404
- kodama.run: 503

Fetched, but body not used in this write-up:
- Discovery URLs in discovery-2026-11-23.txt were not re-fetched into snapshots.
- Switch Rooms shared responsibility and Switch Rooms working safely with agents: still only nav links on the rooms docs snapshot.
- Harness Relay page and README hunks are not in the compact diff. The description change is from the repo snapshot in the fact pack.
- friday.txt returned 200 and is not in the compact diff. The friday README hunk only adds Pi.
- Globster home.txt and security.txt returned 200. Those hunks are not in the compact diff, so no security-claim sentence was available to quote.
- Concord MCP v0.23.0, Agent Relay v18.10.0 through v18.12.0, and mcp_agent_mail v0.3.5 have no release-note body in the pack.
- Threadlines has no marketing-page hunk in the compact diff.
