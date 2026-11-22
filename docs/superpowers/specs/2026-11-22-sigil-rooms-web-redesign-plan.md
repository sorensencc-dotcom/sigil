# Sigil rooms-web redesign plan

- Date: 2026-11-22
- Inputs: `sigil-redesign-brief-2026-11-21.md` (competitor watch, 20 sourced ideas) and a source check of `C:\dev\sigil-repo` at `origin/main` `39112b7`.
- Status: draft. Lock after Chris answers the questions in section 7.

## Source tags

The brief's tags stay in place wherever an idea is reused: **[LIVE 2026-11-21]**, **[RECORDED]**, **[MARKETING]**, **[SECONDARY]**, and **[UNVERIFIED]**.

This plan adds one tag. **[SOURCE main 39112b7]** marks a fact read from the Sigil repository on `origin/main` at commit `39112b7` on 2026-11-22. A source tag settles feasibility, meaning what the relay already supports. It does not settle product intent.

## What the source check changed

The brief was written without access to `C:\dev`. The source check settles six of its "confirm with relay" dependencies.

| Brief assumption | Finding on main | Effect on plan |
|---|---|---|
| The source snapshot may be stale. | `packages/sigil-rooms-web` on main matches the brief's component list. The last web change is PR #166 (sidebar on narrow viewports). The `fix/241` working tree has no rooms-web diff. [SOURCE main 39112b7] | The component inventory below is current. The running Windows UI is still unseen, because the relay did not answer on `127.0.0.1:8765` during the check. |
| Purpose needs relay support. | `POST /v1/rooms` already accepts `description`, and `Room.description` is typed in the client. `client.createRoom` sends only `name`. [SOURCE main 39112b7] | Idea 1 becomes pure client work. Whether it belongs in create-room is still Chris's call (Q9). |
| A loop cap may not exist. | `Room.max_agent_turns` exists. The relay posts `agent_cap_reached`, and `POST /rooms/:id/continue` refills the budget. A human post resets it (`room-loop-guards.test.mjs`). [SOURCE main 39112b7] | Idea 9 can show a real cap. |
| Busy status may not be exposed. | `GET /v1/rooms/:id/invocations` exists and the client never calls it. Timeline event kinds include `router_decision`, `invocation_refused`, `invocation_stopped`, `invocation_failed`, `router_failed`, and `room_halted`. [SOURCE main 39112b7] | Idea 8 (status line) is client work. Machine, repo, and branch are not exposed, so this plan does not promise them. |
| Signatures are invisible to the client. | Each history row already carries `canonical_bytes` (the stored signed bytes, base64url) and `envelope.signature` `{algorithm, key_id, value}`. The client type `RoomEnvelope` drops `signature`. [SOURCE main 39112b7] | An "inspect envelope" view is P0 client work. True in-browser verification still needs a key lookup the browser can reach. |
| Approval cards need new relay work. | The relay renders its own approval page (`approval-ui.mjs`) with a WebAuthn ceremony (`approval-ceremony.mjs`) for high-risk capabilities. The AG-UI projection (`ag-ui-projection.mjs`) is on main, and its follow-up steps are filed as sorensencc-dotcom/sigil issues #240 to #245; #240 and #241 are closed, so #242 to #245 remain. [SOURCE main 39112b7] | Idea 13 reuses that flow. This plan specifies no second approval UI. |

A second review on 2026-11-22 found three limits, each confirmed on main [SOURCE main 39112b7]:

| Limit | Finding | Effect on plan |
|---|---|---|
| No read cursor for the client | `useAck.ts` keeps `acked` and `wanted` in memory, starting at `0n` on mount. History and member responses carry no acknowledged sequence. | A New divider that survives reload needs a local watermark; one that follows the user across devices needs a relay read of the ack cursor. |
| No invocation frames on the stream | `RoomUpdatedFrame.changed` is `messages`, `members`, or `room`. Room events arrive as envelopes, so they trigger `messages` frames. | The status line refetches `/invocations` on each `messages` frame and polls slowly while work runs. A `changed: 'invocations'` frame is a relay improvement. |
| Turn cap is read-only | `POST /v1/rooms` reads only `name` and `description`; the room routes offer `rename` but no settings route. | The cap is shown, not edited. Editing needs a new relay route. |

The same review proposed per-agent and per-invocation Stop scopes. Main has one Stop route per room, so this plan keeps the three existing labels and adds no new scopes.

Two further findings:

- `GET /v1/mentions` exists and the client never calls it. It can drive a "mentions" view without relay work. [SOURCE main 39112b7]
- `room-human-signer.mjs` signs for the operator from the identity file. It signs for every other human endpoint with a relay-custodial key held in `human_signing_keys`. [SOURCE main 39112b7] The "posting as" label (idea 10) must say which applies. The brief lists relay-custodial guest keys as a long-term failure mode.

## Layout and density reference: Grok app

Chris chose layout and density as the traits to borrow from the Grok app, and supplied a screenshot on 2026-11-22. Facts below come from that screenshot only and carry the tag **[SCREENSHOT 2026-11-22]**. No other Grok UI facts are used.

Observed traits:

1. **Sidebar in two tiers.** The top tier is a grid of large agent tiles (three per row, avatar above a truncated name, one badge for a favorite). The lower tier is a conversation list: avatar, bold name, and a one-line preview of the latest message. Search and New buttons sit at the top right; the signed-in user sits at the bottom.
2. **Floating title.** The conversation has no full-width header bar. A rounded pill with avatar and name floats at the top center, and a single action button (share) floats at the top right.
3. **Centered reading column.** Messages sit in one column of roughly 600 to 650 px inside a wider pane, with wide margins on both sides.
4. **Card bubbles.** Each reply sits in a large rounded card (radius around 20 px) with generous padding and body text around 16 to 17 px with tall line height.
5. **Pill composer.** The composer is one rounded pill: an add button on the left, the placeholder "Message [name]", and action buttons on the right.
6. **Calm surfaces.** Near-black background, one step lighter for cards and the selected list row, and almost no borders or dividers. One accent color appears only on the active agent and the primary composer button.

How Sigil adapts them without copying the look:

| Grok trait | Sigil adaptation | Guardrail |
|---|---|---|
| Agent tile grid | A "Pinned" shelf of tiles at the top of the sidebar. Tiles are pinned rooms (pins exist today). Each tile shows the room's agent avatars stacked, a working dot, and an unread count. | Tiles use Sigil's own avatars (below), never Grok's character art. |
| Conversation list with preview | RoomList rows gain an avatar stack, the last message preview with sender name, and the time. | Previews stay plain text. |
| Floating title pill | The room header becomes a floating pill: room name, purpose on hover, member count. Roster, trust, and Stop open from it. | Managers still rename from the pill. Stop also appears in the status line. |
| Centered column | Timeline max width 44rem (about 704 px), centered. Side panels open beside it, not over it, above 60rem. | Existing 60rem and 40rem breakpoints stay. |
| Card bubbles | Comfortable density becomes the default: 16 px body, 1.6 line height, 20 px card radius, and 16 to 20 px card padding. | Agent and human rows still differ by a left rule or tint (section 5). Every card keeps its sender chip and envelope badge. |
| Pill composer | Composer becomes one pill: text area, @ button, and Send, with the "Posting as" line above it. | No add, mic, or voice button until attachments and voice are in scope (Q5). |
| Calm surfaces | Remove most borders; separate layers by background step. Amber appears only on the active room and the Send button. | Trust colors (section 5) stay distinct from amber. |

Sigil avatars: each endpoint gets a deterministic avatar from its endpoint id: a two-letter monogram on one of six token colors, with a ring style that marks the kind (solid ring for human, dashed ring for agent). This gives Grok's at-a-glance identity without copying its mascot shapes.

## 1. Positioning statement

Sigil rooms is the room where agents owned by different people work together, and every row can prove who said it, on whose behalf, and under whose permission. The redesign makes that proof and that governance visible on every screen: who sent each message, who it woke, who may stop it, and who must approve it.

The redesign borrows familiar chat grammar. It does not copy a hosted board or canvas, and it does not treat composer chrome as the product.

## 2. Phased plan

### P0: Make the room legible (client only, about 3 to 4 weeks)

Goal: a returning owner understands the room in five seconds. They can see who is working, what woke them, and what the relay attests about each message.

In scope (no relay change):

1. Sender chips on every row: human, agent, and "acting for [owner]" (ideas 10 and 20).
2. A working status line driven by `/invocations` and room events, with Stop and its three scope labels (idea 8). Transport: refetch `/invocations` on every `messages` frame, and poll every 2 s only while the list is non-empty.
3. Roster controls written as sentences, plus the room's turn cap shown read-only (idea 9).
4. A recipient preview on @mention and Send (idea 11). It mirrors `room-dispatch.mjs`: mentioned agents the sender may invoke show "Will wake"; with no mention, the room's router picks among `joins` agents the sender may invoke, shown as "Router picks from A, B"; unmentioned `mentions_only` agents, `report_only` members, and agents whose `invokable_by` excludes the sender show "Won't wake" with the reason.
5. An "Inspect envelope" drawer that shows canonical bytes, algorithm, key id, and signature value, labeled "Relay-attested, not verified in this browser" (ideas 12 and 18a).
6. Catch-up cues: a New divider, Jump to latest, and day dividers (idea 3, partial). The New divider reads a per-room watermark the client keeps in `localStorage`, so it survives reload in one browser only. Jump to latest and day dividers need no stored state.
7. An optional purpose line in create-room, the room header, and the room list, if Chris approves Q9 (idea 1).
8. A row action menu: copy text, copy link, and inspect envelope (idea 12).
9. Visual refresh within the existing tokens (section 5, idea 16).
10. A collapsed agent exchange that folds agent-only stretches in threads (ideas 4 and 6).

Out of scope: markdown rendering, attachments, PWA and Web Push, search across archived rooms, and in-browser verification.

### P1: Governance in the room (depends on relay and AG-UI work, about 4 to 6 weeks after P0)

Goal: holds, approvals, and join requests reach the right person inside the room and leave a signed record.

In scope:

1. One in-timeline card for holds, approvals, and agent questions, bound to the approver. It opens the relay's existing WebAuthn approval flow. Depends on sorensencc-dotcom/sigil issues #242 to #245 (idea 13).
2. True in-browser Ed25519 verification of `canonical_bytes` (idea 18b). Needs a key lookup endpoint on the relay origin, so the current CSP allows it. The UI names the trust anchor, because a key fetched from the relay cannot catch a compromised relay:
   - "Matches the relay's key": the signature checks against a key the relay served. This proves the stored bytes are intact.
   - "Matches your pinned key": the signature checks against a key pinned in the viewer's contacts. Only this state may use `--trust-verified`.
   - "Can't verify in this browser": WebCrypto rejects Ed25519. Shown as neutral, never as a failure.
3. A cross-device read cursor: a relay read of the caller's acknowledged sequence replaces the local watermark from P0.
4. A room trust summary: what is signed, what the relay can see, and what this browser verified (idea 19).
5. A join-request queue for owners that extends the existing InvitePage: accept, assign a role, or revoke (idea 15).
6. A "Bring an agent" panel with pending and connected states. It never offers a public link (idea 14).
7. A `changed: 'invocations'` stream frame, which retires the status-line poll.
8. A Mentions view backed by `GET /v1/mentions` (pure client; placed here because it competes with catch-up for P0 time).

### P2: Scale and reach (needs Chris decisions first)

Goal: long rooms stay fast, and approvals reach the owner away from the desk.

In scope only if Chris approves:

1. History windowing and Find in room. Needs a relay or API change, because first open loads every row in pages of 100 (idea 3).
2. Handoff rooms with an archived, still-verifiable state (idea 2).
3. Ask-first agent-started threads, if relay semantics for them exist (idea 5).
4. Presence beyond invocations, such as machine (idea 7).
5. PWA and Web Push. The Nov 11 memo paused this work (idea 17, Q6).

### Client work versus relay work

| Work | Pure client | Needs relay or API change |
|---|---|---|
| Sender chips, "acting for" | Yes (`sender.owner_id`, contacts) | No |
| Status line and Stop | Yes (`/invocations`, events, 2 s poll while working) | Optional: `changed: 'invocations'` frame removes the poll |
| Sentence roster, turn cap display | Yes (`max_agent_turns`) | No |
| Turn cap editing | No | A room settings route |
| Recipient preview | Yes (members, modes) | No |
| Inspect envelope | Yes (fields already in history) | No |
| In-browser verification | Crypto code, base64url decoding, key pinning in contacts | A key lookup on the relay origin; confirm Ed25519 WebCrypto support in target browsers |
| New divider (one browser), Jump to latest | Yes (`localStorage` watermark) | No |
| New divider across devices | No | A read of the caller's ack cursor |
| Find in room, windowing | No | Yes |
| Purpose line | Yes (`description` accepted) | No |
| Approval and hold card | Card shell only | Hold state in history or stream; AG-UI issues #242 to #245 |
| Join-request queue | Partial (InvitePage) | Knock or request state |
| Mentions view | Yes (`/v1/mentions`) | No |
| Presence (machine) | No | Yes |

## 3. Information-architecture map

- **Auth**
  - TokenGate (token mode): one "Bearer token" field and Connect.
  - LoginPage (cookie mode): Continue with GitHub, with error states `invite_required`, `invite_expired`, `denied`, and `provider_error`.
  - InvitePage: accept an invite; in P1, also shows "Waiting for the owner's approval".
- **Shell**
  - Topbar: wordmark, Rooms, Mentions (P1), Settings, Live chip, theme toggle, Sign out.
  - Sidebar top: Search and New room buttons.
  - Sidebar tier 1: Pinned shelf of room tiles (avatar stack, working dot, unread count).
  - Sidebar tier 2: all rooms. Each row shows an avatar stack, name, last message preview with sender, time, unread count, and a working dot while invocations run.
  - Sidebar bottom: signed-in identity chip, which opens Settings.
  - Main: the room view.
- **Room view**
  - Floating title pill: name (rename for managers), purpose on hover, member count. It opens Roster and the trust summary (P1).
  - Timeline column: centered, max width 44rem.
  - Timeline: day dividers, New divider, rows, collapsed agent exchanges, system event rows, and approval cards (P1).
  - Status line, shown only while work runs: who is working or "Deciding who answers", and Stop.
  - Composer: "Posting as [identity] · signed by [operator key or relay key]" above a pill that holds the text area, @mention picker, and Send, with a recipient preview beside Send.
  - Side panels, one open at a time: Thread, Roster, Envelope inspector, Trust summary (P1), Join requests (P1, owners only).
- **Room states**
  1. Empty: no messages. Shows purpose and "Bring an agent" (P1).
  2. Idle: no running invocations. The status line is hidden.
  3. Working: one or more invocations run. The status line shows names and Stop.
  4. Capped: `agent_cap_reached` posted. Shows Continue with the remaining budget.
  5. Halted: `room_halted` posted. Shows who stopped what.
  6. Awaiting approval (P1): a card names the approver.
  7. Read-only: the viewer is `report_only` or not a manager. Controls stay visible but disabled, with the reason in text.
  8. Disconnected: the Live chip reads "Live: off", and a banner offers Retry.
- **Settings**
  - Contacts (exists).
  - Identity (new, read-only): endpoint id, key id, and whether the relay or the identity file signs for this user.

## 4. Component inventory

| Component | Decision | Change |
|---|---|---|
| TokenGate | Reuse | Restyle only. Keep sessionStorage, no URL token. |
| LoginPage | Reuse | Restyle. Map each error code to a plain sentence. |
| InvitePage | Extend (P1) | Add a pending-approval state for the join-request queue. |
| RoomList | Replace | Two tiers: Pinned shelf of tiles, then rows with avatar stack, last message preview, time, unread count, and working dot. Pins move to the shelf. |
| NewRoomForm | Extend | Add optional purpose (sent as `description`) if Q9 says yes. Add room templates only with idea 2. |
| RoomHeader | Replace | Becomes a floating title pill with name, member count, and menus for roster and trust. Move Stop to StatusLine; keep a pill Stop only on narrow screens if testing shows the status line is missed. |
| RosterPanel | Replace | Sentence controls in place of raw enums. Show owner, the turn cap, and a pending or connected state for invited agents. |
| Timeline | Extend | Add day dividers, New divider, Jump to latest, and collapsed agent exchanges. Keep page loading as is until P2 windowing. |
| RowView | Replace | Add a sender chip with an "acting for" line, a system event row variant, an action menu, and an envelope badge. Bodies stay plain text. |
| ThreadPanel | Extend | Fold agent-only stretches; each folded reply stays individually attributable and inspectable. |
| Composer | Extend | Restyle as a pill. Add the "Posting as" line, recipient preview, and annotated @mention entries. No command palette, add, mic, or voice button. |
| Avatar | New | Deterministic monogram from endpoint id on one of six token colors; solid ring for human, dashed for agent. Used in rows, chips, tiles, and stacks. |
| PinnedShelf | New | Grid of pinned room tiles at the top of the sidebar. |
| SettingsPage | Extend | Add a read-only Identity tab. |
| Live chip | Reuse | Add a tooltip with the last frame time. |
| ThemeToggle | Reuse | No change. |
| StatusLine | New | Invocation list, "Deciding who answers", and Stop with its three scope labels. |
| EnvelopeInspector | New | Canonical bytes, signature fields, and an honest verification state. |
| CollapsedExchange | New | Participant list, message count, and expand. Never drops rows. |
| SystemEventRow | New | Renders `router_decision`, `invocation_*`, `router_failed`, `agent_cap_reached`, and `room_halted` as sentences. |
| ApprovalCard (P1) | New | Structured fields only. Opens the relay approval flow. |
| TrustSummary (P1) | New | What is signed, what the relay sees, and what was verified here. |
| JoinRequestQueue (P1) | New | Accept, assign role, or revoke. |
| MentionsView (P1) | New | List from `/v1/mentions` with links into rooms. |

## 5. Design tokens

Keep the Rewrite Labs Console tokens: graphite dark, paper light, one amber accent, cool instrument blue, Host Grotesk, and Atkinson Hyperlegible Mono, all self-hosted. Each proposed change below names its reason.

1. **Trust state colors.** Add three semantic tokens that do not reuse amber, so the accent keeps meaning "act here":
   - `--trust-verified`: aliases the existing `--color-ok`. Used only when this browser verified against a pinned key (P1).
   - `--trust-attested`: aliases the existing `--color-cool`. Used for "the relay says so".
   - `--trust-held`: new `--color-held`, hue 310 at the lightness and chroma of `--color-bad` in each theme (starting point: `oklch(70% 0.17 310)` dark, `oklch(46% 0.17 310)` light), with a matching `-soft`. Used for holds and pending approvals. Check contrast before locking.
   Each state also carries an icon and a text label, so color is never the only signal.
2. **Type scale.** Define a five-step scale (for example 12, 14, 16, 20, and 28 px) with one body size for rows. Reason: rows, chips, and metadata currently compete at similar sizes. That is the likely cause of the "tired" feel and needs confirmation against the live UI.
3. **Density.** Add `--row-gap`, `--row-pad`, `--card-radius`, and `--column-max`. Comfortable is the default, matching the Grok reference [SCREENSHOT 2026-11-22]: 16 px body, 1.6 line height, 20 px card radius, 16 to 20 px card padding, and a 44rem column. Compact is a per-viewer toggle stored under a new key such as `sigil.density`: 14 px body, 1.45 line height, 10 px radius, and 8 to 12 px padding. Reason: Chris asked for Grok's airy layout, and agent-heavy rooms still need a dense option.
4. **Surfaces.** Replace most borders with background steps: page, card, and selected row each one step lighter. Reason: matches the calm layering in the reference and lets trust colors stand out.
5. **Avatar colors.** Six token colors for avatars, checked for contrast in both themes, none equal to amber or the trust colors.
6. **Mono usage.** Limit Atkinson Hyperlegible Mono to identifiers, hashes, and the envelope inspector. Reason: mono marks "machine fact", which supports the trust story.
7. **Agent versus human rows.** Use a left rule or a background tint step, not a new hue. Reason: it keeps the palette to one accent plus semantic trust colors.

No new fonts, no third-party font requests, and no changes to the theme key `sigil.theme`.

## 6. Prioritized backlog

Effort: S is under 2 days, M is 2 to 5 days, and L is over 5 days. Risk is the chance the story ships wrong or blocks.

| # | Story | Idea and source | Phase | Effort | Risk | Confirm with Chris |
|---|---|---|---|---|---|---|
| 1 | As an owner, I see who sent each row, whether it is human or agent, and which owner it acts for. | 10 [LIVE 2026-11-21, MARKETING]; 20 [LIVE 2026-11-21]; [SOURCE main 39112b7] | P0 | M | Low | Wording for "acting for". |
| 2 | As a member, I see a status line naming the agents now working, and I can Stop from it with the correct scope label. | 8 [LIVE 2026-11-21]; [SOURCE main 39112b7] | P0 | M to L | Medium (no invocation frame; poll fallback) | Whether Stop leaves the header. |
| 3 | As a manager, I set each agent's wake rule in plain sentences and see the room's turn cap (read-only). | 9 AgentMsgr [LIVE 2026-11-21, MARKETING], Agora [RECORDED]; [SOURCE main 39112b7] | P0 | S | Low | Final sentence copy. |
| 4 | As a sender, I see who my message will wake before I press Send. | 11 [LIVE 2026-11-21, MARKETING] | P0 | M | Medium (router mode makes the result a prediction) | How to word "the router decides". |
| 5 | As any member, I open a row's envelope and see its signed bytes and signature fields, labeled as relay-attested. | 18a Block Buzz [LIVE 2026-11-21], [RECORDED]; [SOURCE main 39112b7] | P0 | S | Low | None. |
| 6 | As a returning member, the room opens at a New divider with Jump to latest and day dividers. | 3 [LIVE 2026-11-21] | P0 | L | Medium (ack model edge cases; one-browser watermark) | Q13. |
| 7 | As an owner, I give a room an optional purpose that shows in the header and room list. | 1 [LIVE 2026-11-21]; [SOURCE main 39112b7] | P0 | S | Low | Q9. |
| 8 | As a reader, long agent-to-agent stretches fold into one card I can expand, and every reply stays attributable. | 4 [LIVE 2026-11-21]; 6 [LIVE 2026-11-21] | P0 | M | Medium (fold must not hide holds) | None. |
| 9 | As any member, I copy a row's text or link from a row menu. | 12 [LIVE 2026-11-21] | P0 | S | Low | Whether "mark unread" is wanted, given the ack model. |
| 10 | As a user, the console feels current: clear type scale, density modes, and trust colors. | 16 Block Buzz, Friday [LIVE 2026-11-21] | P0 | M | Medium (subjective without live screenshots) | Q2, Q3. |
| 10a | As a user, the console uses the Grok-style layout: two-tier sidebar with a pinned shelf and previews, floating title pill, centered 44rem column, card bubbles, pill composer, and a comfortable or compact density toggle. | Layout and density reference [SCREENSHOT 2026-11-22]; 16 | P0 | L | Medium (sidebar rework touches mobile drawer) | None; traits chosen 2026-11-22. |
| 10b | As a member, every sender has a stable avatar that marks human or agent. | Layout and density reference [SCREENSHOT 2026-11-22]; 10 | P0 | S | Low | None. |
| 11 | As an approver, an approval or hold appears in the room as a card naming me, and approving opens the relay's WebAuthn flow and leaves a signed record. | 13 Hyperagent [LIVE 2026-11-21], Nia Teams [LIVE 2026-11-21], Reason [LIVE 2026-11-21], endue [RECORDED]; [SOURCE main 39112b7] | P1 | L | High (depends on #242 to #245) | Hold state delivery to the client. |
| 12 | As any member, my browser verifies each row's signature itself, names the key it trusted (relay-served or pinned), and says so only when it did. | 18b [SOURCE main 39112b7] | P1 | M | Medium (key lookup, trust anchor, browser Ed25519 support) | Q12. |
| 13 | As any member, I open a room trust summary that states what is signed, what the relay can see, and what is not yet verified. | 19 Agent Room, Agent Relay [LIVE 2026-11-21] | P1 | S | Low | None. |
| 14 | As an owner, I see join requests and accept, assign a role, or revoke. | 15 AgentMsgr, Crosswalk [LIVE 2026-11-21], Phone Line [RECORDED] | P1 | M | Medium | Relay knock state (no open question yet; check the relay first). |
| 15 | As an owner, I bring an agent in by copying an invite, and the roster shows pending until it connects. | 14 AgentMsgr, Reason, Agent Room, Plasma Radio [LIVE 2026-11-21; Plasma mock MARKETING] | P1 | M | Low | Invite format. |
| 16 | As a user, I see every message that mentions me across rooms. | [SOURCE main 39112b7] | P1 | S | Low | None. |
| 17 | As a member, I search within a room. | 3 [LIVE 2026-11-21] | P2 | L | High (relay windowing) | Q7. |
| 18 | As an owner, I create a handoff room that I can archive while it stays verifiable. | 2 AgentCouch [LIVE 2026-11-21, MARKETING] | P2 | L | Medium | Archive semantics. |
| 19 | As an owner, an agent asks me before it starts a thread. | 5 Threadlines [LIVE 2026-11-21] | P2 | L | High (relay semantics unknown) | Whether agent-started threads exist. |
| 20 | As an owner, approvals reach my phone. | 17 [LIVE 2026-11-21, MARKETING] | P2 | L | High (paused) | Q6. |

## 7. Open questions for Chris

1. **"Like what Grokbot has."** Answered 2026-11-22: layout and density, from a screenshot of the Grok app. See the layout and density reference. Also answered 2026-11-22: the pinned shelf holds rooms, not individual agents.
2. **Live UI versus source.** Source on main matches the brief's snapshot through PR #166. The running Windows client was not seen, because the relay did not answer on `127.0.0.1:8765`. Does the running client differ from main? Screenshots of the current room would also ground the "tired" diagnosis.
3. **Brand.** Is any visual brand beyond Rewrite Labs Console mandatory?
4. **Scope.** Does a first-class UI override the Nov 11 "drop composer polish" line, or does it stay scoped to making governance visible? This plan assumes the second, with a P0 visual refresh.
5. **Attachments.** Are screenshot or file attachments in scope? Relay support was not checked.
6. **PWA and Web Push.** Should this work be un-paused?
7. **Catch-up and search versus the verifier.** How far should catch-up and search go before in-browser verification?
8. **Markdown.** What is the policy for agent output? This plan keeps plain text.
9. **Purpose.** Should room purpose appear in create-room? The relay already accepts it.
10. **Guest identity.** What is the long-term guest model? Non-operator humans sign with relay-custodial keys today.
11. **Approval surface.** Should the in-room card open the relay's own approval page, or should the AG-UI work (#242 to #245) render approvals inside the client?
12. **Key lookup and pinning.** Which relay endpoint should serve sender public keys? Should contacts hold pinned keys, so a viewer can verify authorship without trusting the relay?
13. **Unread across devices.** Is a one-browser New divider enough for P0, or should the relay expose the caller's ack cursor first?
14. **Turn cap editing.** Should managers edit `max_agent_turns` (1 to 50)? That needs a new relay route.

### Answers from Chris, 2026-11-22

| Q | Answer | Effect on the plan |
|---|---|---|
| 2 | Bring up the relay and client, run a live walkthrough, and document it with screenshots. | Separate session. Evidence feeds the P0 diagnosis. |
| 3 | The whole brand could use a refresh. | Brand refresh enters P0 scope. Needs a design pass beyond Rewrite Labs Console tokens. |
| 4 | Yes, drop the Nov 11 "drop composer polish" line. | First-class UI is in scope. |
| 5 | Accepted suggestion: defer. | Attachments move to P2 and wait on a relay support check. |
| 6 | Accepted suggestion: un-pause later. | PWA and Web Push stay in P2. No effect on P0 or P1. |
| 7 | Accepted suggestion: catch-up before search. | Catch-up stays in P0. Search stays in P2. |
| 8 | Wants better than plain text. | Markdown policy needed. Open design question: safe subset, no raw HTML. |
| 9 | Yes, optional at room creation. | Purpose stays optional. |
| 10 | No guests. Every participant is a user or a user's linked agent. | Removes the guest model. Relay-custodial human keys need a replacement plan. |
| 11 | Accepted suggestion: relay approval page first, in-room AG-UI approvals later. | P1 ships the card that opens the relay page. A later phase moves approval into the room after #242 to #245. |
| 12 | Accepted suggestion: pin keys in contacts. | P1 builds key pinning and a key lookup route. |
| 13 | Accepted suggestion: one-browser New divider in P0, relay read cursor in P1. | No change to the P0 and P1 split. |
| 14 | No recommendation given, none accepted. | Open. Turn cap stays read-only in P0. Decide before P1. |

## 8. Failure modes and non-goals

Non-goals:

1. Feature parity with hosted boards or canvases (Nov 11 memo).
2. A command palette or other controls not found in sources. The Switch "Room commands" page returned 404 on 2026-11-21.
3. A recreation of any competitor's UI, including Grok's. Borrow layout and density only; never its character avatars, colors, or wordmark.
4. Voice, mic, and add buttons in the composer until those features are in scope.
5. Markdown or HTML rendering of agent output without a decided policy.
6. Attachments, until relay support is confirmed.

Failure modes to guard against:

1. **A fake verified mark.** Show green only when this browser computed the signature check. Until then, label rows "relay-attested".
2. **Open-by-default access.** No "anyone with the link" rooms and no workspace-open rooms (Plasma Radio [RECORDED]; Hyperagent [LIVE 2026-11-21]).
3. **Approvals by the wrong person.** An approval card names one approver and accepts only that person's ceremony.
4. **A second approval system.** Reuse the relay WebAuthn flow and the AG-UI work, so two approval paths cannot diverge.
5. **Folding that hides state.** A collapsed exchange never hides a hold, a cap event, or a signature state.
6. **A mark-unread action that breaks acks.** Do not ship mark-unread until it is reconciled with ack-only-shown-rows.
7. **Raw enums as the only roster UI.**
8. **Overclaims.** No SOC 2 or zero-retention claims without proof.
9. **Secrets in chat.** Never ask for webhook keys or tokens in a room.
10. **Custodial keys presented as personal signatures.** If the relay signs for a user, the composer and inspector say so.
11. **Marketing montages treated as shipped UI.** This covers Agent Relay, Terminus Teams [SECONDARY, UNVERIFIED], and Concord MCP claims labeled U.
12. **Global reply tokens beyond tests** (Nov 11).
13. **Embedded competitor demos.** Link out instead.

### Decisions and phase tracker

Status as of 2026-11-22. Nothing is built yet. Each line names the phase that owns the work, so no later phase is lost.

| Item | Phase | Status | Depends on |
|---|---|---|---|
| Live UI walkthrough with screenshots | Before P0 | Done: PR #252. The client on port 5173 was a stale 2026-10-30 build, and router, hold, and cap events were not reproduced. | Rebuild the client from main and sign in to close Q2 |
| Brand refresh beyond Rewrite Labs Console tokens (Q3) | P0 | Added to scope. Needs a design pass. | Live walkthrough evidence |
| Optional purpose at room creation (Q9) | P0 | Approved | None |
| Markdown for agent output (Q8) | P1 | Wanted. Needs a policy: safe subset, no raw HTML, no remote images. | Policy decision |
| Remove the guest model (Q10): every participant is a user or a user's linked agent | P1 | Decided. Needs a plan to replace relay-custodial human keys with keys users hold. | Relay and identity work |
| Approval card opens the relay page (Q11, option A) | P1 | Approved | #242 to #245 for hold delivery |
| In-room approvals through AG-UI (Q11, option B) | Later than P1 | Planned | #242 to #245 |
| Key lookup route and contact key pinning (Q12) | P1 | Approved | Relay route; Ed25519 WebCrypto check |
| Cross-device read cursor (Q13) | P1 | Approved | Relay read of the ack cursor |
| Turn cap editing (Q14) | P1 | Open | Room settings route; Chris decision |
| Attachments (Q5) | P2 | Deferred | Relay support check |
| PWA and Web Push (Q6) | P2 | Deferred | Nov 11 memo pause lifted |
| Find in room and history windowing (Q7) | P2 | Deferred | Relay windowing |
| Handoff rooms, ask-first agent threads, presence | P2 | Deferred | Chris decisions on archive and thread semantics |

New backlog stories from these answers (numbers continue section 6):

| # | Story | Phase | Effort | Risk |
|---|---|---|---|---|
| 21 | As a user, I see a refreshed brand across the console, not only the existing tokens. | P0 | M to L | Medium (needs design direction) |
| 22 | As a reader, agent output renders as a safe markdown subset. | P1 | M | Medium (no raw HTML; policy first) |
| 23 | As a user, I sign with a key I hold, and no guest or relay-custodial human identity exists. | P1 | L | High (identity and relay work) |
| 24 | As an approver, I approve inside the room without leaving it. | After P1 | L | High (#242 to #245) |
| 25 | As a member, I attach a screenshot or file. | P2 | L | High (relay support unknown) |

## 9. Statechart check of the plan

Model: `docs/superpowers/specs/statechart/RoomsPlan.tla`, with `p0.cfg` (hold state not delivered to the client, New divider from a local watermark) and `p1.cfg` (hold state delivered, New divider from a relay read cursor). Two devices, a turn cap of 2, one trust check. TLC explored about 75,000 states for P0 and 61,000 for P1. The model encodes what this plan says. Where the plan is silent, the model allows every choice, so a break means the plan must state a rule.

| Rule, as the reader sees it | P0 | P1 | What to add to the plan |
|---|---|---|---|
| A hold waiting on me always shows as a card | Breaks: no hold state reaches the client | Holds | Do not ship the approval card until #242 to #245 deliver hold state. Until then, P0 must say "approval needed" from the relay page, not from a card. |
| A read row never appears under New | Breaks: read on device A, reopen on device B, B shows it as New | Holds | Matches Q13. Accepted split stays, and the P0 divider label must say "this browser". |
| A folded exchange never hides a hold | Not reachable (no card in P0) | Breaks: fold a live exchange, then a hold arrives | A new hold, cap event, or signature state must unfold the exchange or pin a badge above it. Folding only checks the state at fold time today. |
| A folded exchange never hides a cap event | Breaks | Breaks | Same rule. The cap event is the shortest path: fold while an agent works, then the agent replies and hits the cap. |
| A forged row never looks trusted when I pinned the sender's key | Breaks | Breaks | The plan names two anchors with no precedence. State that a pinned key is always checked first, that a mismatch shows as a failure, and that "Matches the relay's key" never shows for a sender with a pin. |
| "Matches your pinned key" only shows when the pin matched | Holds | Holds | None. |
| Agents never exceed the turn cap | Holds | Holds | None. |

Not modeled: approver identity (the relay's WebAuthn ceremony enforces it, not the client), the 2 s poll lag, effects of the stream having no invocation frame, and Stop scope labels. The statechart run on the walkthrough in PR #252 covers the status line.

To rerun: `statechart RoomsPlan.tla --config p0.cfg --view view.mjs --out out-p0`.

