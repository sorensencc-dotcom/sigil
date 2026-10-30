# Windows stack launcher (STOPGAP)

**This is a short-term stopgap for one Windows machine.** The real fix is a cross-platform `sigil service install`, tracked in [#132](https://github.com/sorensencc-dotcom/sigil/issues/132). Delete this directory when that lands.

`start-sigil-stack.ps1` loads `%USERPROFILE%\.sigil-secrets\floor-warden.env` into its own process environment (names logged, values never), then starts the relay (8791, stream 8792, public 8793, ingress 8796), Chief, and rooms-web (5173). It only adopts a relay with all four listeners up, or rooms-web whose `/config.json` reports cookie auth; for Chief, it recognizes a node process using `chief.identity.json`. Dead children restart with backoff from 1 s up to 5 min. Logs go to `.sigil\logs\` (`supervisor.log`, `<name>.out.log`, `<name>.err.log`).

`-WhatIf` prints the planned commands with secrets masked and starts nothing.

## Only one launcher

Do not run a second launcher for the relay or rooms-web. For example, an elevated scheduled healer that starts rooms-web without `--auth-mode cookie` can make `rooms.rewritelabs.io` show the bearer-token box instead of **Sign in with GitHub**. Look for a `REFUSING to adopt` line in `supervisor.log` and check `http://127.0.0.1:5173/config.json` for a missing `authMode`. Stop that process and disable its scheduled task; the supervisor will not kill it or start a duplicate on its occupied port.

`register-sigil-task.ps1` registers a per-user `SigilStack` logon task that runs the launcher. It uses a limited-rights principal, so no admin shell is needed. `-Unregister` removes it. `-StartNow` starts it right away.

Known limit: the relay only accepts `--room-bot-key-wrap-key` as a literal value, so it is visible on the relay's command line to local processes, the same as before this script.
