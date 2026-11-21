---
title: "Approval challenges can bind the signed envelope, and the field is optional so existing callers keep working"
author: Chris
date: 2026-11-21
branch: feat/approval-challenge-envelope
cost: { minutes: 19, tokens: 64217 }
id: l-106e2393
scope: repo
status: active
src: agent
touches:
  - sigil/relay/v1/approval-envelope.mjs
  - sigil/relay/v1/approval-envelope.test.mjs
  - sigil/migrations/042_approval_challenge_envelope.sql
  - sigil/relay/v1/postgres-repository.mjs
  - sigil/relay/v1/http-server.mjs
  - sigil/relay/v1/approval-ui.mjs
  - sigil/relay/v1/approval-ui.test.mjs
---

## Decided
- An approval challenge may carry the signed envelope the human is approving. The relay recomputes its canonical hash, requires the sender to be the authenticated endpoint, and verifies the signature before storing the envelope, so the details on the approval page cannot differ from what the approval binds.
- The envelope field is optional, not required. Existing callers send only an action hash, and a required field would break them. The AG-UI projection should emit an interrupt only for challenges that carry an envelope. The approved spec said required; the PR flags this as a deliberate change.
- The stored action hash is normalized to bare hex when an envelope is bound, because the approval consumer matches hex.
- The full envelope is stored as JSONB next to conversation, message id and capability columns that must be all set or all null (a table check enforces it).

## Tried and ruled out
- Storing only the hash and letting the AG-UI client supply the arguments: a client could show one action while the hash binds another.
- Rendering the body on the approval page without truncation: a hostile or huge body would bury the hash. The page truncates at 2000 characters and escapes everything.

## Watch out
- If SIGIL_TEST_DATABASE_URL is set in your shell to a database that is not running, every live-DB suite fails with connection errors instead of skipping, which looks like hundreds of pre-existing failures. Unset it for unit runs, and point it at a throwaway database whose name ends in _test for live runs.

In the code:
- Binding and checks: sigil/relay/v1/approval-envelope.mjs; route in sigil/relay/v1/http-server.mjs (POST /v1/approval-challenges)
- Columns: sigil/migrations/042_approval_challenge_envelope.sql; repository in sigil/relay/v1/postgres-repository.mjs
- Page: envelopeRows in sigil/relay/v1/approval-ui.mjs
