---
title: "Opening a room message from another page uses in-memory focus, because rooms have no URL"
author: Chris
date: 2026-11-24
branch: t3/rooms-web-mentions-view
cost: { minutes: 1, tokens: 1538 }
id: l-80a45272
scope: repo
status: active
src: agent
touches:
  - packages/sigil-rooms-web/src/App.tsx
  - packages/sigil-rooms-web/src/rooms/Timeline.tsx
  - packages/sigil-rooms-web/src/pages/MentionsView.tsx
---

## Decided
- Rooms in the web client have no URL. Only top-level pages (/, /mentions, /settings) use pathnames, so jumping to a room message passes a focus message id through state, not a link. Opening a mention selects the room like the sidebar does, then the timeline outlines the row and scrolls it into view once. If the message is a thread reply, its thread opens instead.
- Every top-level navigate clears the focus, so returning to Rooms through the nav doesn't scroll to and outline the old row again.
- The Mentions page gives DATABASE_UNAVAILABLE its own sentence, because the shared error banner says "Rooms are unavailable" while rooms still work.

## Tried and ruled out
- A /rooms/:id deep link: no room URL convention exists, and adding one is wider than the mentions story.
- Adding GET /v1/mentions to the contract test: relay-api.json has no entry for it, so the test would throw, and the contract file is outside the web package.

## Watch out
- The relay sorts mentions by each room's own message sequence number across rooms, so the list is not in time order. Don't label it "newest first".
- The memory repository has no mentions query, so a relay running without a database returns 503 for mentions while rooms still work.
- The focus effect in the timeline must run after the scroll-to-bottom effect and run only once per focus id, or each live frame fights the scroll. jsdom has no scrollIntoView, so call it with optional chaining.

In the code:
- App.tsx Shell: focusMessageId state, openMention, and navigate clearing focus
- rooms/Timeline.tsx: focusedFor ref effect; RowView sets aria-current="true" on the focused row
- relay: sigil/relay/v1/room-routes.mjs GET /v1/mentions; postgres-repository.mjs listMentionsForEndpoint (ORDER BY room_seq DESC, limit capped 1 to 100)
