# Windows stack launcher (STOPGAP)

**This is a short-term stopgap for one Windows machine.** The real fix is a cross-platform `sigil service install`, tracked in [#132](https://github.com/sorensencc-dotcom/sigil/issues/132). Delete this directory when that lands.

`start-sigil-stack.ps1` loads `%USERPROFILE%\.sigil-secrets\floor-warden.env` into its own process environment (names logged, values never), then starts the relay (8791, stream 8792, ingress 8796), Chief, and rooms-web (5173). Anything already listening on its port (or, for Chief, any node process using `chief.identity.json`) is left alone. Dead children restart with backoff from 1 s up to 5 min. Logs go to `.sigil\logs\` (`supervisor.log`, `<name>.out.log`, `<name>.err.log`).

`-WhatIf` prints the planned commands with secrets masked and starts nothing.

`register-sigil-task.ps1` registers a per-user `SigilStack` logon task that runs the launcher. It uses a limited-rights principal, so no admin shell is needed. `-Unregister` removes it. `-StartNow` starts it right away.

Known limit: the relay only accepts `--room-bot-key-wrap-key` as a literal value, so it is visible on the relay's command line to local processes, the same as before this script.
