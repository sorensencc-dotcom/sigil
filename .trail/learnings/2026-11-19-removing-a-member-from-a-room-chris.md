---
title: "Removing a member from a room has no command, so it means a soft delete in the database"
author: Chris
date: 2026-11-19
branch: main
id: l-1f10f0c8
scope: repo
status: active
src: agent
touches:
  - "sigil/relay/v1/postgres-repository.mjs#removeRoomMember"
---

## Decided
To remove a retired bot from a room, mark its membership row as removed: set `removed_at` to the current time. Sigil has no HTTP route, CLI command, or rooms-web action for removing a member. The only code that does it is a repository method, and only tests call it. Disable the bot itself with `sigil bot disable` first.

## Tried and ruled out
- The rooms-web client: it can list members and change a member's response mode or who can invoke it, but it cannot remove one.
- `sigil bot --help`: it offers add, disable, and token commands, with nothing for room membership.

## Watch out
The removal is a soft delete, so it can be undone: set `removed_at` back to NULL on that row. Run the same UPDATE the repository method runs. Do not delete the row.

In the code:
- `PostgresRepository.removeRoomMember` runs `UPDATE conversation_members SET removed_at = $3 WHERE conversation_id = $1 AND endpoint_id = $2 AND removed_at IS NULL`. The `conversation_id` is the room id (`room_...`).
- Bot status is the `status` column (active or disabled) of the `floor_warden_bots` table, keyed by `bot_id` with `endpoint_id` and `display_name`.
