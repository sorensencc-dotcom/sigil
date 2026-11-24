# Sigil hybrid rooms and direct messages: decided answers

Decision date: 2026-10-16. Recorded from the operator-supplied decisions on 2026-10-17.

## Scope and status

[PR #58](https://github.com/sorensencc-dotcom/sigil/pull/58) merged the docs-only [design](2026-10-16-sigil-hybrid-rooms-direct-messages-design.md) and [task plan](../plans/2026-10-16-sigil-hybrid-rooms-direct-messages.md) as `ffb2f156f5a579762dc2b4b147490307070f58c0` at 9:17 PM America/New_York on 2026-10-16. Its branch was deleted. This follow-up records supplied answers; it does not implement them or authorize unresolved choices.

The Q numbers below refer to the design's open questions. These answers supersede conflicting proposals in that design and its plan only for the explicitly decided parts. The local phase 5 verification commits `0abc9b6` and `ce16bb1` are a separate recovery follow-up, not hybrid implementation or SQLite verification evidence.

## Decided answers

### Q1: Frame messages from the owner's human endpoint

Frame these messages as untrusted pre-input and apply the same validation as any other input. Origin grants no bypass. Keep the peer-input boundary fail-closed, consistent with the phase 5 stale-lock rationale. An owner marker is provenance, not instruction authority.

### Q3: Accept the soren alias

Accept `soren` as an alias for `usr_soren` in addresses. Alias-table placement remains unresolved; the design notes that the endpoints table has no handle column.

### Q4 and Q5: Fan-out and liveness

- Cap fan-out at 20 targets. This answer approves the cap; it does not separately resolve the proposal to charge quota per target.
- Send a heartbeat every 30 seconds.
- Expire a session after 90 seconds of silence measured from its last heartbeat. Each beat resets the timeout: "still here, give me more time".
- A busy session remains live while beats continue. Do not expire it after 90 seconds of work or implement a rigid three-missed-beats wall.

### Q6: Prefer the existing SQLite store

Use SQLite by reusing `sigil/connectors/v1/sqlite-store.mjs`. Rotated JSONL is a fallback only if the hybrid plan's Task 1 SQLite check fails. The choice aims to support queries without adding a dependency. This document does not claim that the reuse check has passed.

### Q9: Defer the web directory panel

Defer the web directory panel to a later iteration.

## Q7: Supplied Reason Network summary

The requester specified inclusion of this reference summary. It is context, not approval to adopt every feature. The supplied account names `reasonmachines.com` and `reason-machines/reason-network` and says it derives from README, DESIGN.md, and SECURITY.md, without running the software or reading Rust source. This follow-up reproduces that account; it does not independently verify those sources or current behavior.

According to the supplied summary, Reason Network provides a peer-to-peer directory of live coding-agent sessions and a message bus. One daemon per machine uses iroh QUIC with relay fallback, without a server for the operator to host.

Ideas supplied for comparison with Sigil:

- Sender-visible delivery tiers (`push`, `turn`, `pull`) indicate whether a message wakes the recipient.
- A live directory shows person, machine, agent, repository, branch, busy or idle status, and a one-line "doing" field drawn from the session title and todo list.
- Addresses support `person/*`, `repo:acme/api`, and bare unique names. A new session can inherit a stale name and unread mail.
- Receipts distinguish stored, delivered, held, and refused outcomes. Per-machine inbound policy supports accept, hold, and refuse.
- Peer text is framed as peer input, not user instructions. Per-sender limits and a cap on consecutive agent-to-agent messages require human involvement.
- Setup detects installed agents and backs up configuration; a doctor command supports diagnosis.

The supplied comparison credits Sigil with signed envelopes, relay and room history, and shared human/bot rooms. It describes Reason Network as signing only its roster and lacking cryptographic cutoff for removed machines. Treat those comparative security claims as unverified reference notes, not acceptance evidence.

The public page and repo were read on 2026-10-18, and the result is in the [design comparison section](2026-10-16-sigil-hybrid-rooms-direct-messages-design.md#reason-network-comparison). That section labels each claim as verified or unverified. The earlier comparative security claims are now labeled there, since the roster is signed, the design lists no per-message signature, and removed machines are not cryptographically cut off (Verified: repo docs). No decided answer changes.

## Issue 294: uncertain delivery state (spec change, 2026-11-23)

[Issue 294](https://github.com/sorensencc-dotcom/sigil/issues/294) asks for an outcome beside `held` and `refused` for a send whose result is unknown. The design and the [delivery receipts design](2026-10-05-sigil-delivery-receipts-design.md#direct-message-states-and-uncertain-outcomes) now carry it. This section records the changes. It is a spec change only and authorizes no code. The reference for the idea is the AX 0.8.3 note in the 2026-11-23 weekly competition analysis (PR #285), which separates a definite refusal from an uncertain outcome. That source is unverified beyond that note.

Specified in the design:

- `uncertain` is a fifth `dm_state` and a raw delivery state added by migration 038 beside `held` and `refused`. It means the relay handed a message to a session and cannot tell whether the session showed it. `refused` stays a definite refusal.
- The design adds a full transition table, including the five transitions that touch `uncertain`.
- The retry rule is: never resend blindly. Resend only the identical signed envelope, with the same `message_id` and `idempotency_key`, until the envelope expires. After expiry, read the receipts route instead.
- A send whose `202` is lost is a sender-local outcome, not a stored state.

Left unresolved by this record:

- The exit code for an uncertain send. The receipts design proposes `9`. The plan must confirm it is free.
- Whether `uncertain` extends to deliveries with no `session_id` (design Q11) and how a clean session end behaves (design Q12).
- Backlog and held counts in discovery. These are a follow-up, because they need a cross-owner visibility decision.
- Whether the policy parameters reaper's lease reclaim for `delivered` rows and the `uncertain` move are one mechanism (design Assumption 12).

## Unresolved decisions and external follow-ups

- **Q2:** Cross-owner default remains undecided: hold is proposed; refuse is the alternative.
- **Q3 remainder:** Decide alias storage and lookup ownership.
- **Q4 remainder:** Confirm quota charging per target separately from the approved fan-out cap.
- **Q8 (resolved by merge order):** [Phase 6 PR #59](https://github.com/sorensencc-dotcom/sigil/pull/59) merged first as `e027579` with `035_floor_warden_bridge.sql`. [PR #62](https://github.com/sorensencc-dotcom/sigil/pull/62) updated the phase 5 and hybrid documents accordingly: 035 remains phase 6, 036 is reserved for phase 5 (`report_only_mode`), and hybrid work retains 037 and 038. The earlier proposal to renumber phase 6 is superseded; do not rename an already-merged migration. Recheck current migration filenames before implementing the remaining phases.
- **Q10:** Assign ownership for external `C:\dev\scripts\run-sigil-daemon.ps1` follow-ups: remove the reported inline database password through an approved environment or secret-store configuration, and reconcile stream port 8792 with the mesh skill's 8793. No secret file was opened or changed for this document, and neither port is selected here.

The decisions above do not authorize a merge, runtime deployment, credential change, daemon restart, or implementation of unresolved policy.
