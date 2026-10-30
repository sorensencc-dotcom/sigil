# OAuth login manual smoke checklist

Run this once against real GitHub before you hand a link to a guest. The automated e2e (`sigil/integration/oauth-login.e2e.test.mjs`) covers the topology with a fake GitHub; this checklist covers what only the real provider and a real phone can prove.

Spec: `docs/superpowers/specs/2026-10-11-sigil-rooms-third-party-login-design.md`.

## Prerequisites

- A Postgres relay already running rooms with `--room-human-identity` and `--room-key-wrap-key` (see README "Multi-human rooms").
- A dedicated hostname on your tailnet with HTTPS (for example `rooms.<tailnet>.ts.net`). Cookies use the `__Host-` prefix, so a path prefix on a shared hostname does not work.
- A built web client: `npm run build` in `packages/sigil-rooms-web`.
- A second GitHub account (or a friend) to act as the guest, and a phone on the tailnet.

## Steps

1. Create a GitHub OAuth App (Settings, Developer settings, OAuth Apps).
   - Homepage URL: `https://<hostname>`.
   - Authorization callback URL: `https://<hostname>/v1/auth/oauth/github/callback`.
   - Open item 1: if GitHub rejects the tailnet hostname, record the failure here and fall back to a domain you own that resolves to the same proxy. Write the domain you used: `____________`.
2. Export the credentials in the shell that starts the relay.
   ```bash
   export GITHUB_OAUTH_CLIENT_ID=<client id>
   export GITHUB_OAUTH_CLIENT_SECRET=<client secret>
   ```
3. Start the relay with the public origin.
   ```bash
   sigil relay up --port 7777 --database-url "$SIGIL_DATABASE_URL" \
     --public-origin https://<hostname> \
     --room-human-identity .sigil/<you>.identity.json \
     --room-key-wrap-key SIGIL_WRAP_KEY \
     --room-system-identity .sigil/relay_system.identity.json
   ```
   Expect the startup output to print `Public origin`, `Cookie-only listener: 127.0.0.1:<port>`, and the proxy table. Note the cookie-only port (default `--port` plus 2).
4. Start the static server in cookie mode.
   ```bash
   node packages/sigil-rooms-web/bin/sigil-rooms-web.mjs --auth-mode cookie --public-origin https://<hostname> --port 5173
   ```
5. Publish the two upstreams behind one hostname with the proxy table the relay printed. For Tailscale (adapt the flags to your installed version):
   ```bash
   tailscale serve --bg --https=443 --set-path /v1 http://127.0.0.1:<public-port>/v1
   tailscale serve --bg --https=443 --set-path / http://127.0.0.1:5173
   ```
   Confirm `Set-Cookie`, `Origin`, and `Host` pass through unchanged (Tailscale does by default; another proxy may not). `/v1/stream` WebSocket upgrades must go to the same upstream as `/v1/*`.
6. Open item 4: confirm `api.github.com` is reachable from the operator machine (unauthenticated calls are limited to 60 an hour).
   ```bash
   curl -s https://api.github.com/users/<your-login> | head -5
   ```
7. Create your own login invite (valid 10 minutes, pinned to your human).
   ```bash
   sigil relay invite create --self --provider github --login <your-github-login> \
     --identity .sigil/<you>.identity.json --database-url "$SIGIL_DATABASE_URL" --public-origin https://<hostname>
   ```
8. Open the printed `https://<hostname>/invite#<token>` link on your phone over the tailnet. Check:
   - [ ] The address bar loses the `#<token>` fragment right after the page loads.
   - [ ] Continue with GitHub goes to github.com, then back to the rooms list signed in.
   - [ ] The operator-only controls (new room, roster controls) are visible.
   - [ ] Reloading the page keeps you signed in.
9. Create a room, then invite a guest.
   ```bash
   sigil relay invite create --name Guest --room <room_id>:member \
     --identity .sigil/<you>.identity.json --database-url "$SIGIL_DATABASE_URL" --public-origin https://<hostname>
   ```
10. Send the link to the guest. Check on the guest's device:
    - [ ] Login completes and shows only the invited room.
    - [ ] The operator-only controls are absent.
    - [ ] The guest posts a message and you see it on your phone without a reload.
    - [ ] Using the same link a second time fails with the "invite expired" message.
11. Revoke an unused invite.
    ```bash
    sigil relay invite create --name Spare --room <room_id>:member ...   # note the invite_id
    sigil relay invite revoke <invite_id> --identity .sigil/<you>.identity.json --database-url "$SIGIL_DATABASE_URL"
    sigil relay invite list --database-url "$SIGIL_DATABASE_URL"
    ```
    - [ ] The link now fails, and `list` shows the invite as revoked.
12. With the guest's tab still open, revoke the guest identity.
    ```bash
    sigil relay identity revoke --provider github --login <guest-github-login> \
      --identity .sigil/<you>.identity.json --database-url "$SIGIL_DATABASE_URL"
    ```
    - [ ] The guest's open tab drops its live connection within a few seconds and the next action returns to the login page.
    - [ ] The guest cannot log back in without a new invite.
13. Log out on your phone.
    - [ ] The live connection closes and a reload shows the login page.

## Record

| Item | Result |
| :--- | :--- |
| Open item 1: GitHub accepted the tailnet hostname callback | |
| Fallback domain, if any | |
| Open item 4: `api.github.com` reachable, rate limit seen | |
| Proxy used and whether Origin, Host, and `Set-Cookie` passed through | |
| Anything that behaved differently from the steps above | |

## Known limits worth knowing before you share a link

- A targeted invite (`--human <human_id>`) that reactivates a previously revoked identity is consumed, but it adds no rooms. Add rooms afterward with `sigil human add-to-room`.
- Sessions expire after 7 days idle or 7 days absolute, whichever comes first.
