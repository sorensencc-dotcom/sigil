# Sigil CLI — status and roadmap

## What exists tonight (2026-08-15)

A CLI at `sigil/cli/sigil.mjs`, four commands:

- `sigil init <name> --owner <owner_id>` — generates an Ed25519 keypair + relay/connector tokens, saves them to `.sigil/<name>.identity.json`, and registers the public identity in `.sigil/registry.json`.
- `sigil relay up --registry <path> --port <n>` — runs a real `relay/v1/http-server.mjs` in the foreground, backed by an in-memory store (`sigil/cli/memory-repository.mjs`).
- `sigil send --identity <path> --relay-url <url> --to <endpoint_id> --to-owner <owner_id> --message "text"` — builds, signs, and posts a `chat.message` envelope.
- `sigil inbox --identity <path> --relay-url <url> [--watch|--wait] [--loop]` — polls or listens for inbox messages, prints messages, and acknowledges delivery. `--wait` consumes exactly one message and exits; `--wait --loop` keeps re-arming after timeouts. Timeout is exit code 2, auth failure 3, connection failure 4, and malformed delivery 5.

Verified end to end tonight: two identities (`ep_claude`, `ep_codex`) registered against one relay, `send` from one, `inbox` on the other, and back. Real signature verification, real HTTP, real envelope validation — no mocks in that path.

No `package.json`/`bin` entry yet (matches this repo's existing "no root package.json" convention — see main `README.md`). Invoke as `node sigil/cli/sigil.mjs <command>`.

## What this is not

- **Not multi-user.** The registry is a local JSON file you edit by hand (via `init`). There's no directory service, no way to discover or trust a stranger's endpoint, no identity verification beyond "the public key in this file matches."
- **Not hosted.** `sigil relay up` is a foreground process on localhost. Its in-memory store is intentionally ephemeral: messages, acknowledgements, and idempotency state are lost on restart. Use the PostgreSQL relay path for restart durability.
- **Not integrated into any chat UI.** Sending a message does not make it appear inside an actual Claude or Codex conversation. Host adapters may background `sigil inbox --wait` and act on the host's task-completion notification, but that notification is a host convention, not a Sigil protocol guarantee.
- **Not a packaged install.** `npm install -g sigil` installs an unrelated package (confirmed 2026-08-15 — `sigil` on this machine's PATH resolves to `C:\Users\soren\AppData\Roaming\npm\sigil.cmd`, a different tool). There is no published package for this repo.

## What a real "message Claude ↔ Codex, works for other people" product needs

Roughly in the order it'd need to be tackled:

1. **Packaging** — a real `bin` entry (own `package.json` scoped to `sigil/cli/`, or a root one if the "no package.json" convention is revisited), published so `npm install -g @you/sigil` (or similar) is the whole install step.
2. **A relay someone actually hosts** — not `sigil relay up` in a terminal window. Needs the PostgreSQL-backed repository (`relay/v1/postgres-repository.mjs`) already in this repo, deployed somewhere reachable, plus operational concerns (TLS, backups, uptime) this repo doesn't address at all.
3. **Real identity/directory** — some way for two people who've never met to find and authorize each other's endpoints. Today `init` trusts whatever's in a local file. `docs/specs/sigil-human-approval-auth-spec-v1.0.md` and `sigil-plugin-connector-auth-spec-v1.0.md` sketch pieces of this (WebAuthn approval ceremonies, OIDC identity linking) but nothing wires a first-time "add this person" flow.
4. **Push, not poll** — `sigil inbox --wait` now uses the existing WebSocket notify-on-delivery stream for one-shot host handoff. A real product still needs a native chat-surface adapter.
5. **Actual chat-surface integration** — the hard, unbuilt part. Getting a Sigil message to show up as a turn inside a live Claude conversation or a live Codex conversation requires each product to expose some extension point Sigil can write into. Neither this repo nor (as far as this session found) either product currently has that hook. Until that exists, the ceiling for "does this feel like messaging," even with everything else built, is: a person runs `sigil inbox --watch` in a terminal and reads it there.

## Immediate next candidates (not started)

- Give the CLI a real `package.json` + `bin` so step 1 above stops being manual.
- Add host-specific adapter instructions for backgrounding `sigil inbox --wait` and re-arming after each turn.
- Decide whether "hosted relay" is in scope at all, or whether this stays a local/self-hosted tool by design.
