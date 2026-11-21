---
title: A retried high-risk envelope skips the approval gate only when the relay already accepted that exact envelope
author: Chris
date: 2026-11-21
branch: fix/high-risk-retry-idempotent
cost: { minutes: 61, tokens: 389424 }
id: l-5440d08b
scope: repo
status: active
src: agent
touches:
  - sigil/relay/v1/accept-envelope.high-risk-retry.test.mjs
  - sigil/relay/v1/accept-envelope.mjs
  - sigil/relay/v1/postgres-repository.integration.test.mjs
---

## Decided
- A retried high-risk envelope skips the approval gate only when the relay already holds an idempotency record with the same canonical hash and the route is local delivery. The gate's single-use approval was spent on the first acceptance, so running it again can only fail.
- The skip is safe because signature, expiry, grant and rate checks still run, and the duplicate check afterwards either returns the original acceptance or throws. It can never accept a new envelope.

## Tried and ruled out
- Moving the duplicate lookup in front of all validation: it would answer a duplicate before the signature is verified, so a forged retry would get a 202.
- Skipping the gate on forwarded routes too: the forward branch returns right after the gate, so skipping there would forward without any approval.

## Watch out
- Keep exactly one consumption per accepted envelope; an earlier merge that ran the gate twice rejected already-approved envelopes.
- The sync-forward path has no local idempotency record, so a retry there still needs a fresh approval.

In the code:
- Skip: acceptedRetry before enforceCapabilityRiskGate in the Phase 2 transaction, sigil/relay/v1/accept-envelope.mjs
- Tests: sigil/relay/v1/accept-envelope.high-risk-retry.test.mjs; live-Postgres retry in sigil/relay/v1/postgres-repository.integration.test.mjs
