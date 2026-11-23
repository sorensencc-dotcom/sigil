#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Run both model variants against the expectations before checking source drift.
node verify/ag-ui-approval/check.mjs --require-tla

SYNC=$(sed -n 's/^Sync commit: `\([0-9a-f]*\)`.*/\1/p' .claude/skills/verify-ag-ui-approval/SKILL.md)
if [ -z "$SYNC" ]; then echo "Missing Sync commit in verify-ag-ui-approval skill."; exit 1; fi
changed=$(git diff --name-only "$SYNC" -- $(cat verify/ag-ui-approval/covered-files.txt))
if [ -n "$changed" ]; then
  echo "Covered code changed since $SYNC; re-read it against AgUiApproval.tla and move the sync commit only after TLC passes:"
  echo "$changed"
  exit 1
fi
echo "No covered file changed since $SYNC."
