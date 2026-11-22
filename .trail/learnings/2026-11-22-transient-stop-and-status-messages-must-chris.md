---
title: Transient Stop and status messages must not displace failure or cap banners
author: Chris
date: 2026-11-22
branch: docs/rooms-web-live-walkthrough
cost: { minutes: 1, tokens: 0 }
id: l-d5e21595
scope: repo
status: active
src: agent
touches:
  - docs/superpowers/specs/2026-11-22-rooms-web-live-walkthrough.md
---

## Decided
In the rooms client redesign, the 'nothing to stop' reply to an idle Stop press is a transient toast. The failure sentence and the cap banner with Continue stay on screen until the state changes. A TLA+ model of the plan's status line showed that a note which replaces the last message breaks both rules.

## Tried and ruled out
Modelling the note as part of the room message area: TLC found two counterexamples (failure then Stop, cap then Stop).

## Watch out
The statechart CLI is a PATH shim, so run it from PowerShell, not Git Bash.

In the code:
statechart RoomUi.tla --config plan.cfg --view view.mjs --out <new folder>
