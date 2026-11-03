# Expected /statechart results

| Config | Rules that must break | Why |
|---|---|---|
| `MC.cfg` (real code, trigger sender already revoked) | `NoSurvivingInvocation` | Known finding in `STATUS.md`: pick's `FOR SHARE` is on a revoked endpoint, so `suspendHuman`'s `UPDATE endpoints WHERE status = 'active'` does not wait. The scan misses the uncommitted pick, then the pick commits a running row. |
| `MC_active.cfg` (real code, trigger sender still active) | none | The active-endpoint `UPDATE` waits on the pick's `FOR SHARE`, then the scan sees the committed running row and cancels it. |
| `MC_lock_human.cfg` (`STATUS.md` fix, sender revoked) | none | `FOR SHARE` on `humans` before the endpoint lock. Suspend waits on that row, then either cancels a committed pick or the pick reads `suspended` and refuses. |
| `MC_no_endpoint_lock.cfg` (drop `lockEndpointForShare`, sender still active) | `NoSurvivingInvocation` | Without the sender lock, an active sender races the same way a revoked one does today. |

Read each break as the `path:` line `node verify/suspend-pick/check.mjs` prints. The known `MC.cfg` path is:

router locks the trigger sender's endpoint → router locks the room → router reads the subject's status → operator starts suspending the human → operator suspends active endpoints → operator scans for running invocations → router commits the invocation → operator locks scanned rooms → operator commits the suspension

The scan is empty because the pick has not committed. The operator then takes no room lock and never cancels.
