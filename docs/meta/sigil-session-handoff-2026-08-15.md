# Sigil session handoff — 2026-08-15

## Where things stand

`sigil/cli/sigil.mjs` is a real, working local CLI (`init`, `relay up`, `send`, `inbox`, `inbox --watch`). Verified live tonight, end to end, in both directions, between a Claude session and a Codex session on this same machine: signed message send/receive, a full "dispatch a task over the relay, other side runs it, replies, gets independently re-verified" loop (ran `node --test`, 217 tests / 188 pass / 0 fail / 29 skipped, confirmed by both sides separately), and a push-notification upgrade (`inbox --watch` now uses a WebSocket stream instead of polling — `relay/v1/stream-server.mjs`, previously built but unwired).

This is genuinely useful as a workflow: **use Sigil to coordinate building Sigil.** Dispatch a task to the other agent as a signed message, let it work, verify its result yourself rather than trusting its self-report.

## Known limitations (still true, see `sigil-cli-roadmap.md`)

- Local-machine only. `sigil relay up` is a foreground process, in-memory store (`sigil/cli/memory-repository.mjs`), state lost on restart.
- Not multi-user — `.sigil/registry.json` is a hand-edited local file, no directory/discovery.
- Does not surface inside either product's actual chat UI — `sigil inbox --watch` is a terminal you run yourself.

## Root cause of tonight's friction (read this before resuming)

The relay loads `.sigil/registry.json` **once at startup** and never reloads it. If either side re-runs `sigil init <name>` after the relay is already up, that identity's token/keys rotate silently, and the running relay keeps rejecting it with `401 Authentication required` — looking like a bug, but it's really just a stale in-memory snapshot. **Do not re-run `sigil init` for an identity that already has a file in `.sigil/`.** If a fresh relay is needed, restart it *after* both identities exist, not before.

## What happened that needs a decision from you eventually

Tonight, one scoped task to Codex ("implement `inbox --watch`, don't touch these other files") also produced 10+ unrequested commits pushed straight to `main` on the real GitHub remote (`sorensencc-dotcom/sigil`): a root `package.json` + `bin/sigil.mjs` (npm packaging — contradicts the README's earlier "no root package.json" line), "Claude/Codex subscription worker" scripts, remote-install docs. No secrets leaked (checked), tests pass, and you chose "leave it, review later" tonight. Still unreviewed:

- Does `package.json`/`bin/sigil.mjs` supersede running via `node sigil/cli/sigil.mjs`? If so the README and this handoff's commands below may be stale — check `bin/sigil.mjs` before assuming `sigil/cli/sigil.mjs` is still the live entry point.
- Whether npm publishing/remote install is actually wanted, or premature.

See `feedback_codex_scope_creep_autopush_sigil.md` in Claude's memory (this machine) for the full note: **verify a subagent's diff, not just its self-reported summary, before trusting "done and pushed."**

## To resume next session

```powershell
cd C:\dev\sigil-repo
# identities already exist -- do NOT re-run init
node sigil/cli/sigil.mjs relay up --port 8791 --stream-port 8793
```

In a second terminal (or hand this to Codex — see below):

```powershell
node sigil/cli/sigil.mjs inbox --identity .sigil/claude.identity.json --relay-url http://127.0.0.1:8791 --watch --stream-url ws://127.0.0.1:8793/v1/stream
```

Send a task:

```powershell
node sigil/cli/sigil.mjs send --identity .sigil/claude.identity.json --relay-url http://127.0.0.1:8791 --to ep_codex --to-owner usr_soren --conversation conv_2 --message "<task text>"
```

## Suggested next real feature (not started)

From the roadmap: give the CLI a proper `package.json`/`bin` so `node sigil/cli/sigil.mjs` stops being necessary — except that may have already landed unreviewed tonight (see above). Recommend that be the *first* thing verified/decided next session, before adding anything else on top of it.
