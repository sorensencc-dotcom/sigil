---
title: Keep the word token out of worktree folder names and run live database tests one file at a time
author: Chris
date: 2026-11-16
cost: { minutes: 32, tokens: 174732 }
id: l-81b39f99
scope: repo
status: active
src: agent
touches:
  - sigil/cli/phase7-setup-inspect.mjs
  - sigil/cli/phase7-setup-inspect.pg.test.mjs
  - sigil/cli/phase7-setup-inspect.test.mjs
  - sigil/relay/v1/reply-token.mjs
  - sigil/relay/v1/reply-token.test.mjs
  - sigil/scripts/assert-disposable-test-db.mjs
---

## Decided
Name sigil worktrees without "token", "secret" or "bearer" in the path, and run *.pg test files serially against a throwaway database.

## Watch out
- The chief-watchdog test checks that its WhatIf output does not match /TOKEN|SECRET|Bearer/i. That output includes the repo path, so a worktree named like sigil-wt-token-expiry fails the pre-push suite even though nothing leaks.
- Two *.pg test files run in parallel against the same database both apply migrations at once and fail with a duplicate key on pg_type_typname_nsp_index. This is a test-runner collision, not a schema bug.

## Tried and ruled out
- npm run test:live:local on this Windows host: no PostgreSQL server binaries, so it exits early. Use the sigil_postgres container with a database whose name ends in _test.

In the code:
- Watchdog leak assertion: tests/trm-ACT-SIGIL-CHIEF-DAEMON-LOGON-TASK-WATCHDOG style test, regex /TOKEN|SECRET|Bearer/i on Register logon task WhatIf output.
- Serial run: point SIGIL_TEST_DATABASE_URL at the sigil_postgres container (127.0.0.1 port 55432, user sigil, a database ending in _test), then run node --test --test-concurrency=1 <files>.pg.test.mjs
- Guard: sigil/scripts/assert-disposable-test-db.mjs refuses names not ending in _test.
