# RESUME — Sigil FIX session layer

Handoff for a fresh session. Written 2026-09-09.

## State

- **Brainstorming → done.** Approach A locked.
- **`/plan-eng-review` → done.** SCOPE_REDUCED. Findings A1/A2/CQ1 folded. 13 test
  gaps + 1 critical regression added. Review logged.
- **`/plan-ceo-review` → done.** SELECTIVE EXPANSION. 3 of 4 expansion proposals
  accepted into Plan 1 (observability, `stream_seq` flag-gate, out-of-order
  release on permanent gap); `sigil session-status` CLI deferred. Review logged.
- **Design doc → written, self-reviewed, committed.**
  - Branch: `spec/fix-session-layer`, commit `637c0e9` (in `sigil-repo`).
  - `docs/superpowers/specs/2026-09-08-sigil-fix-session-layer-design.md` — Plan 1 design.
  - `docs/superpowers/specs/2026-09-08-sigil-fix-session-layer-ceo-plan.md` — scope record.
  - `TODOS.md` — 3 deferred items appended (NAK Plan 2, federated checkpoint, session-status CLI).

## Next step

Run `superpowers:writing-plans` against
`docs/superpowers/specs/2026-09-08-sigil-fix-session-layer-design.md` to produce
the implementation task breakdown. The design's "Parallelization" section already
sketches the two lanes and the commit sequencing for the `relay_jobs` refactor.

Not yet done: Codex outside-voice on the design doc (skipped during review — no
plan-mode file at the time). Optional to run now that the doc exists.

## Plan 1 scope, one screen

1. Migration `020`: `stream_sequences` table + `envelopes.stream_seq` column + partial unique index.
2. Stamp `stream_seq` per `(sender_endpoint_id, conversation_id)` in `acceptWithRepository`,
   inside the existing transaction, behind config flag `stream_seq.enabled` (default off),
   local conversations only (federated inbound stays NULL).
3. Expose `stream_seq` on inbox listing, `delivery.receipt`, and the `delivered` stream frame.
4. Generalize `federation_outbox` + `federation-reaper` into a shared `relay_jobs` queue
   (`job_type` discriminator). Two commits: (a) refactor federation, federation suite green;
   (b) add `resend` job type.
5. `session.resend_request` signed envelope (contract schema + validator wiring).
   Accept path validates + enqueues a `relay_jobs` row only — no delivery, no fan-out
   in the transaction. Auth = active `conversation_members`. Counts against `quota_usage`.
6. Resend worker (`job_type = 'resend'`): look up `envelopes` in `[begin, end]`, re-push
   over the requester stream; collapse aged-out ranges into one `sequence_reset` frame;
   re-queue (not dead-letter) on a closed socket.
7. `stream-gap-tracker.mjs` connector module (shared CLI + adapters, injected storage):
   contiguous advance, buffer + debounced `session.resend_request`, honor `sequence_reset`,
   reload high-water on restart, on permanent failure release out-of-order + emit
   `unrecoverable_gap` event.
8. CLI: `sigil inbox` (now contiguous per stream), `sigil inbox --gaps`, `sigil resend`.
9. Observability: 7 metrics, structured logs, dashboard panel spec, 2 alerts.
10. Tests: 22 cases in the design's test plan; #6 (federation drain green after
    `relay_jobs` refactor) is the CRITICAL regression gate.

## Watch

- CWD drifted between `C:\dev` and `C:\dev\sigil-repo` during the review session.
  The work is in `C:\dev\sigil-repo`. Pass explicit `-C` / absolute paths.
- `sigil` MCP server was disconnected at handoff time.
