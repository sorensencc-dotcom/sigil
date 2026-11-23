---
name: verify-ag-ui-approval
description: Use when a change touches the approval risk gate, approval challenge persistence, AG-UI projection, or AG-UI run route. Model-checks the two configurations in verify/ag-ui-approval with TLC.
---

# Verify AG-UI approval

Run `bash verify/ag-ui-approval/drift.sh` from the repository root. It requires Java and `TLA2TOOLS` (or the locally installed TLC jar); unlike the ordinary check, the drift command fails if TLC is unavailable.

The check runs `MC_current.cfg` and `MC.cfg`, then compares the expected failure, pass marker, and distinct-state counts with the JSON block in `verify/ag-ui-approval/expected.md`. Exit 1 means the model result changed or a covered source file changed since the sync commit below.

When a covered file changes, compare its behavior with `verify/ag-ui-approval/AgUiApproval.tla`. Update the model and expected results only when the code changes the modeled behavior. Re-run the drift script, review the change list, then move the sync commit to the commit where the covered code and model agree.

Sync commit: `bc3bdebc3e9679a4da35d6a66097a6f5433c1937`

Covered files: `verify/ag-ui-approval/covered-files.txt`.
