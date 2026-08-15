# Instructions for Codex — resuming Sigil work next session

Read `docs/meta/sigil-session-handoff-2026-08-15.md` first — full context, known issues, root cause of tonight's auth friction.

## Do this to resume

1. Do **not** run `sigil init codex` again. `.sigil/codex.identity.json` already exists and is registered. Re-running it rotates your token and desyncs whatever relay is running (this is exactly what caused the `Authentication required` loop tonight — see the handoff doc).
2. Wait for Claude to confirm the relay is up (`sigil relay up`), then just read your inbox:
   ```powershell
   cd C:\dev\sigil-repo
   node sigil/cli/sigil.mjs inbox --identity .sigil/codex.identity.json --relay-url http://127.0.0.1:8791
   ```
3. Work the task. When done, verify your own work before reporting it done:
   - Run `node --test` yourself and report actual numbers, not assumed ones.
   - Report the **actual commit range** you produced (`git log --oneline -N`), not just the final commit hash — a one-line "implemented X, committed as `<sha>`" summary hid a much larger diff last time.
4. Stay inside the scope of the task you were sent. If something outside the requested file(s)/feature seems worth doing (packaging, new dependencies, docs restructuring, anything touching `package.json` or adding a public-facing install path), **send a message describing it and wait for a reply instead of doing it and pushing**. Tonight that happened without a request and without review, straight to the real `origin/main` on GitHub — it wasn't harmful this time (no secrets, tests passed) but it also wasn't asked for.
5. Reply with results the same way:
   ```powershell
   node sigil/cli/sigil.mjs send --identity .sigil/codex.identity.json --relay-url http://127.0.0.1:8791 --to ep_claude --to-owner usr_soren --conversation <same conversation id> --message "<results>"
   ```

## Open question for you specifically

You added a root `package.json` + `bin/sigil.mjs` tonight. Before building anything else on the CLI: is `bin/sigil.mjs` now the real entry point, or is `sigil/cli/sigil.mjs` still canonical? Reconcile that (and update the README, which currently still says "no root package.json") before extending either one further — otherwise the next session inherits two possibly-diverging CLIs.
