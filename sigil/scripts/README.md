# Live PostgreSQL test gate

`live-db-tests.mjs` runs Sigil's schema-resetting integration suites
against a real PostgreSQL instance, one file at a time, so their
`DROP SCHEMA public CASCADE; CREATE SCHEMA public` resets can never race
each other.

## Why sequential, not parallel-with-isolated-schemas

`node --test` runs test *files* concurrently by default. Each live suite
below resets the entire `public` schema at the start of its tests:

- `relay/v1/postgres-repository.integration.test.mjs`
- `relay/v1/identity-auth-audit-atomicity.test.mjs`
- `relay/v1/identity-auth-repository.integration.test.mjs`
- `migrations/003_plugin_connector_auth.test.mjs`

Running two of those concurrently against the same database is a real,
reproduced failure (`duplicate key value violates unique constraint
"pg_type_typname_nsp_index"` from two overlapping `CREATE SCHEMA`/migration
runs). Per-suite schema/database namespacing was considered and rejected:
the suites already hard-code `public` and share one connection string, so
namespacing would mean editing every suite (out of scope) versus just
serializing execution (one line of scheduling logic). Strict sequential
execution was chosen for that reason.

The runner discovers suites by content, not a hardcoded list: any
`*.test.mjs` file under `sigil/` containing the literal
`process.env.SIGIL_TEST_DATABASE_URL` is treated as a live suite -- the same
gate expression the suites use to skip themselves when no live database is
configured. Add a new live suite and the runner picks it up automatically.
(The marker is the exact `process.env.SIGIL_TEST_DATABASE_URL` read, not a
bare mention of the variable name, so files that only reference the name in
prose or assertions -- like this runner's own regression test -- aren't
mistaken for suites needing a live database.)

## Usage

```sh
SIGIL_TEST_DATABASE_URL=postgres://sigil:<password>@localhost:55432/sigil \
  node sigil/scripts/live-db-tests.mjs
```

The runner:

1. Requires `SIGIL_TEST_DATABASE_URL` up front (exits 1 if unset).
2. Polls the database with `SELECT 1` until it accepts connections or a
   30s timeout elapses.
3. Discovers live suites and runs each with `node --test <file>` in its own
   child process, awaiting one before starting the next.
4. Runs every discovered suite regardless of earlier failures, then prints
   an aggregate summary (`tests`, `suites`, `pass`, `fail`, `cancelled`,
   `skipped`, `todo`, files run, failed files).
5. Exits 0 only if every suite process exited 0 and the aggregate `fail`
   count is 0; exits 1 otherwise.
6. Clears `SIGIL_TEST_DATABASE_URL` from its own process env in a `finally`
   block, so the variable does not leak past the gate into whatever runs
   next in the same shell/session.

Individual suites are unmodified and still run standalone exactly as
before: `node --test relay/v1/postgres-repository.integration.test.mjs`.
Running `node --test` (no path) still runs the whole tree, including these
files -- that path remains parallel and unaffected; use this runner
specifically as the deterministic live-PostgreSQL gate.

## Regression coverage

`live-db-tests.test.mjs` unit-tests the scheduler itself with fake suite
runners (no real database needed):

- asserts max concurrently-active suite count is exactly 1, even when fake
  suites do staggered async work that would overlap under a buggy
  `Promise.all`/`map` scheduler
- asserts a mid-run failure doesn't short-circuit remaining suites
- asserts the summary parser and env-clearing helper behave correctly

Run it like any other suite: `node --test sigil/scripts/live-db-tests.test.mjs`.
