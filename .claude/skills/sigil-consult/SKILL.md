---
name: sigil-consult
description: Send the current context/question to a Sigil peer (Codex) for a second opinion, wait for the reply, and report back. Use when the user says "ask Codex", "get a second opinion", "check with Codex over Sigil", or /sigil-consult.
---

# Sigil Consult

Send a question or design to another agent (Codex) over the local Sigil relay and wait for its reply, without manual "check your inbox" relaying. This codifies the pattern proven live on 2026-08-15/16: send, background `inbox --wait`, report when it fires.

## Preconditions

- Canonical checkout is `C:\dev\sigil-repo` — always run Sigil commands from there. A second checkout (`C:\dev\sigil`) exists with its own separate `.sigil/` identities; using it silently talks to the wrong registry (root cause of a real incident this session).
- A relay must already be up on `http://127.0.0.1:8791` / stream `ws://127.0.0.1:8793/v1/stream`. Check with:
  ```powershell
  netstat -ano | findstr "8791 8793"
  ```
  If nothing is listening, start one (identities must already exist in `.sigil/registry.json` — never re-run `sigil init` for an identity that already has a file, it silently rotates tokens and the relay's in-memory snapshot goes stale):
  ```powershell
  cd C:\dev\sigil-repo
  node sigil/cli/sigil.mjs relay up --port 8791 --stream-port 8793
  ```

## Process

1. **Compose the message.** Summarize the question/context/design tersely — the recipient has no memory of this conversation. Include enough for them to act without asking follow-ups, but don't paste the whole transcript.
2. **Send it:**
   ```powershell
   cd C:\dev\sigil-repo
   node sigil/cli/sigil.mjs send --identity .sigil/claude.identity.json --relay-url http://127.0.0.1:8791 --to ep_codex --to-owner usr_soren --conversation <conv_id> --wait-for-receipt --message "<message>"
   ```
   Reuse an existing `--conversation` id if this is a continuation of an earlier exchange; otherwise omit it (auto-generates one) and remember it for follow-ups.

   `--wait-for-receipt` opens the stream before sending and prints `-> queued`, `-> delivered`, and `-> acknowledged` lines as the relay reports them. Against a Postgres relay the first line is `queued`; an in-memory relay (`sigil relay up` with no database) prints `delivered` first. It exits `0` on `acknowledged` or `processed`, exits `7` on `processing_failed` or `dead_letter`, and exits `8` if no terminal receipt arrives within 60 seconds. Exit `7` and exit `8` both mean the relay accepted the message: **do not resend**, because the recipient may already have it. A 60-second timeout is not success and not a failed send; it means the receipt has not arrived yet. Any other non-zero exit (usually `1`) means the send itself failed, and resending is safe. Report what it printed and the exit code to the user. Any receipt line (`queued` or `delivered`) means the relay accepted the message. `acknowledged` means the recipient's listener picked it up, which does not prove the recipient has read it. If only `queued` or `delivered` printed and the command exited `8`, say so: the recipient has not picked it up yet, and the wait in step 3 will not tell you, because it watches your own inbox.
3. **Arm the wait, backgrounded:**
   ```powershell
   node sigil/cli/sigil.mjs inbox --wait --identity .sigil/claude.identity.json --relay-url http://127.0.0.1:8791 --stream-url ws://127.0.0.1:8793/v1/stream
   ```
   Run this as a background task. It exits on its own the moment a reply arrives (or on timeout/error — see exit codes below) — the background-task-completion notification is what surfaces the reply into this session. Do not poll it manually while it's running; that defeats the point.
4. **Tell the user Codex needs to check its own inbox** (this skill doesn't control Codex's session) — unless Codex already has its own `--wait` armed from a prior turn in this same collaboration.
5. **When the wait exits, read its output.** Exit code 0 means a message arrived — read the printed line, act on it, report to the user. Non-zero:
   - `2` timeout (default 300s) — re-arm if still waiting, or tell the user nothing came back
   - `3` auth, `4` connection — relay/registry problem, diagnose before retrying (see stale-relay-snapshot note above)
   - `5` malformed — the delivered item didn't parse as expected; do not treat as a normal reply
   - `130`/`143` — the wait was interrupted; nothing was acknowledged, safe to re-arm

## What this is not

Not a persistent inbox integration — each consult is a manual send + one background wait, scoped to this skill invocation. See `docs/meta/sigil-host-inbox-wait-convention.md` and `docs/superpowers/specs/2026-08-15-sigil-inbox-wait-design.md` in `sigil-repo` for the underlying mechanism and its adapter-convention caveat (background-task-completion-on-exit is host behavior, not a Sigil protocol guarantee).
