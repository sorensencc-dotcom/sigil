# Ironbots wiring note (phase 5)

How a script on the Ironbots host calls `sigil room report`. This plan does not edit `C:\dev\scripts`.

## Per-bot run

```text
sigil room report --identity <path> --relay-url <url> --room <room_id> --bot <id> --status <s> --summary <text> --state <path>
```

Pass `--report-at <iso>` when the same logical report may be retried. Omit `--report-at` so each run is a distinct report and the post policy decides.

## Daily bundle

Once a day, post the daily summary with `--from-report ironbots_daily_report.json` (same identity, relay URL, room, and state path). The operator supplies the room id; a `room_id` inside the JSON is not trusted.

## Exit codes the host script must honor

- **Exit 0** — posted, reconciled (`reconciled` via receipts 200), skipped as `already_posted`, policy skip, or operator `--drop-pending` / `--break-lock` / `--break-state-lock`.
- **Exit 1** — usage error; fix the invocation.
- **Exit 2** (`report_refused`, pending dropped and logged) — only the closed set of permanent refusals that prove no commit: deterministic content refusals on any send; `INVALID_ENVELOPE`, `DUPLICATE_MESSAGE`, and `REPLAY_DETECTED` on a first send only (`state` was `signed` at run start). Do not retry the same envelope.
- **Exit 3** — retry later. Covers transient failure, a rejected retry or RECONCILE whose receipts lookup returns 404 or fails (`report_pending_unresolved`), a later run for the same bot and `--report-at` skipped as `pending` while that pending record stays unresolved, or lock timeout (`lock_timeout`).

## FRESH and RECONCILE (no automatic recreate)

The same command either resends the stored envelope (inside 4 minutes of its creation, FRESH) or queries the receipts route (at 4 minutes or more in RECONCILE, or immediately when a FRESH retry is rejected with `INVALID_ENVELOPE`, `DUPLICATE_MESSAGE`, or `REPLAY_DETECTED`). It never automatically resends or recreates a stale envelope.

A 404 from receipts means the relay holds no committed message at that moment, not that an in-flight or blocked request cannot still commit. Other 4xx responses such as 401, 403, 408, 425, and 429 are transient (exit 3). Those three envelope codes (`INVALID_ENVELOPE`, `DUPLICATE_MESSAGE`, `REPLAY_DETECTED`) on a retry (`state` was `sending` at run start) keep `pending` and reconcile through receipts.

## Same `--report-at` versus a new report

Passing the same `--report-at` makes repeated calls the same report: a repeat whose base key matches `baseKey(last_key)` exits 0 as `already_posted` (including when `last_key` has an `_r<n>` suffix from `--resend-as-new`); a repeat while `pending` is unresolved skips without building an envelope and exits 3 as `pending`. Omitting `--report-at` makes each run a distinct report decided by the post policy.

## Operator setup

The operator creates the `report_only` endpoint and adds it to the room. The state file path must be on a local disk. The lock files next to it are advisory, local-disk only, and never auto-stolen.

## Clocks and HTTP timeout

Poster and relay clocks only decide whether the poster attempts a FRESH send. With skewed clocks, a FRESH retry (`state` was `sending` at run start) rejected as `INVALID_ENVELOPE` keeps `pending` and reconciles through the receipts route (never by dropping `pending`). Clock skew on a first send (`state` was `signed` at run start) can cause a rejected first send (`INVALID_ENVELOPE`, exit 2, `report_refused`, pending dropped and logged because no earlier attempt was sent) or an unnecessary reconcile, never a duplicate. The poster HTTP timeout (30 seconds or less) does not affect duplicate safety because neither a rejected retry nor RECONCILE automatically re-sends.

## Unresolved pending and operator recovery

A report whose receipts lookup returns 404 or fails stays pending (`report_pending_unresolved`, repeated exit 3) and blocks that bot's later reports until the original commits and receipts returns 200, or an operator checks the room and relay and runs:

- `--drop-pending` — drops the pending record.
- `--resend-as-new` — operator-asserted that the original was not and will not be accepted; re-sends the pending record's own report fields as a new envelope with an `_r<n>` idempotency key. If the operator is wrong and the original later commits, a duplicate report appears.

A crashed poster leaves its lock file until an operator runs `--break-lock <bot>` or `--break-state-lock` (operator-asserted that no holder process is alive). Breaking a lock with a live holder can let concurrent state-file writes overwrite another bot's pending record, causing a duplicate or a lost report.

## Delivery guarantee

Delivery is exactly once except when an operator runs `--drop-pending` on an accepted report that is then re-posted, when an operator runs `--resend-as-new` and the original later commits, or when an operator runs `--break-lock` or `--break-state-lock` with a live holder.
