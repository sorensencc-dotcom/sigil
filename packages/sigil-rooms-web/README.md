# @sorensencc/sigil-rooms-web

Browser client for Sigil rooms. It runs on your own machine against your own relay.

## Run it

1. Build the client: `npm install && npm run build` in this directory.
2. Start the relay with a fixed port, the web origin, and the human identity:

   ```bash
   sigil relay up --port 7777 --browser-origin http://127.0.0.1:5173 --room-human-identity .sigil/<you>.identity.json
   ```

3. Start the web server: `node bin/sigil-rooms-web.mjs --relay-url http://127.0.0.1:7777`.
4. Open `http://127.0.0.1:5173` (exactly that origin; `localhost` is a different origin to the relay).
5. Paste your human endpoint's `relay_token` from `.sigil/<you>.identity.json`.

`--stream-url` defaults to the relay URL with its port plus one, matching `relay up --port`. Pass it when you set `--stream-port`.

## What it does

Paste-token login, room list, timeline, send, ack, and live updates through `room.updated`. Threads, Stop, and roster modes are phase 4b-2.

## Security notes

- The token lives in `sessionStorage`: it survives a reload and clears when the tab closes. Never in `localStorage` or a URL.
- Message text renders as plain text only. The server sends a Content-Security-Policy header that limits connections to the relay and stream URLs.
- The client does not verify message signatures. It trusts the relay on your machine.

## Develop

- `npm test` runs the Vitest suite. `npm run test:e2e` runs Playwright against a real relay.
- Test files are `*.spec.ts(x)`. Do not name them `*.test.ts`: Node 24's `node --test` in the sigil root would pick them up.
- Spec: `docs/superpowers/specs/2026-10-07-sigil-rooms-phase-4b1-web-client-design.md`.
