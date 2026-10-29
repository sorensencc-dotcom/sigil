#!/usr/bin/env bash
# Lists covered files that changed since the sync commit (see the verify-room-delivery skill).
# Exit 0: no drift. Exit 1: re-read the listed files against RoomDelivery.tla.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
SYNC=$(sed -n 's/^Sync commit: `\([0-9a-f]*\)`.*/\1/p' .claude/skills/verify-room-delivery/SKILL.md)
changed=$(git diff --name-only "$SYNC" -- $(cat verify/room-delivery/covered-files.txt))
if [ -n "$changed" ]; then echo "Covered code changed since $SYNC:"; echo "$changed"; exit 1; fi
echo "No covered file changed since $SYNC."
