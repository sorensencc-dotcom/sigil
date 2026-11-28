# Phase 7 owner-run setup runbook

Use this runbook to prepare host storage, run `sigil/scripts/phase7-setup.mjs`, and recover from partial runs. The live Grok smoke run is separate from setup (`phase7-setup.mjs` never runs the live smoke test, calls the routine, or restarts the relay).

## Secret storage

Store `registry.json`, the operator identity, and relay/agent identity files outside the repository under `%USERPROFILE%\.sigil-secrets\`. `validateSetupConfig` rejects `secretRoot`, `operatorIdentityPath`, `registryPath`, and bot `identityPath` values inside the repository.

1. Copy the live files out of `.sigil\` into `%USERPROFILE%\.sigil-secrets\`:

```powershell
$dest = Join-Path $env:USERPROFILE '.sigil-secrets'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

foreach ($name in @(
  'registry.json',
  'antigravity.identity.json',
  'grokbot.identity.json',
  'relay-system.identity.json',
  'chief.identity.json'
)) {
  Copy-Item -Force (Join-Path 'C:\dev\sigil-repo\.sigil' $name) (Join-Path $dest $name)
}
```

2. Strip inherited ACLs and grant access only to your operator account and `NT AUTHORITY\SYSTEM` (run `/inheritance:r` before `/grant:r` so no `(I)` inheritance entries remain):

```powershell
foreach ($name in @(
  'registry.json',
  'antigravity.identity.json',
  'grokbot.identity.json',
  'relay-system.identity.json',
  'chief.identity.json'
)) {
  $file = Join-Path $dest $name
  icacls $file /inheritance:r | Out-Null
  icacls $file /grant:r "${env:USERNAME}:(F)" "NT AUTHORITY\SYSTEM:(F)" | Out-Null
}
icacls (Join-Path $dest 'registry.json')
```

3. In `.sigil/service.json` (see `docs/service-config.md`), point `relay.registry`, `relay.identities.federation`, `relay.identities.room_system`, `relay.identities.room_human`, and the `chief` agent's `identity` at `%USERPROFILE%\.sigil-secrets\`, and set `relay.domain` to `rewritelabs.io` so `sigil service start` runs the relay with `--domain rewritelabs.io`, matching `phase7-setup-policy.mjs`. `scripts/windows/start-sigil-stack.ps1` is deprecated and only forwards to `sigil service start`.
4. Restart `SigilStack` from an **Administrator PowerShell** session (stopping the task alone leaves elevated `node.exe` processes bound to ports `8791` and `5173`, which `Test-Running` adopts as `"external"`):

```powershell
Stop-ScheduledTask -TaskName SigilStack
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'sigil\.mjs (relay up|agent run)|sigil-rooms-web\.mjs' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName SigilStack
```

5. Confirm `http://127.0.0.1:8791/v1/health` returns `{"status":"ok","registry_refresh":true}` and check `.sigil\logs\supervisor.log`, `.sigil\logs\relay.out.log`, and `.sigil\logs\chief.out.log`, then delete the superseded copies in `.sigil\`.

### What this storage protects against, and what it does not

These limits came out of the Phase 7 setup review on issue #200. They are accepted for a single-user Windows host.

- **Anyone running as you, as `SYSTEM` or as an administrator can read the secrets.** `routine.credentials.json` is plain JSON inside the protected root, with no DPAPI wrapping, and the identity files are the same. The directory and file ACLs are the only protection, so keep the `icacls` listing above clean: only your account and `NT AUTHORITY\SYSTEM`, with no `(I)` entries.
- **Prompted secrets live as strings in memory while setup runs.** The hidden prompt zeroes its byte buffers, but the decoded value is a JavaScript string in Node and a .NET string in the PowerShell helper, and neither can be wiped. A memory dump of either process taken during the run could hold the value.
- **The PowerShell helper is trusted by its path.** Setup runs `sigil/cli/phase7-setup-windows.ps1` from the repository checkout with `-ExecutionPolicy Bypass`. Keep the checkout writable only by your account, so no other user can replace the helper before you run setup.
- **Path checks and writes are not one atomic step.** Setup checks each path for junctions and other reparse points, then writes. A process running as you could swap a folder for a junction in between. Such a process can already read your files, so this adds little, but do not run setup while untrusted tools run under your account.

## Dry-run

Run `phase7-setup.mjs` without `--apply` to inspect the database, registry preflight, routine secret state, and relay refresh probe without writing files, acquiring locks, or prompting:

```powershell
node sigil/scripts/phase7-setup.mjs --config "$env:USERPROFILE\.sigil-secrets\phase7\setup.json"
```

Exit code `0` means no blockers remain; exit code `2` lists missing prerequisites or blockers (such as `registry-refresh-unverified` or a repo-local path).

`registry_refresh` comes from the relay: setup asks `http://127.0.0.1:<ports.relay>/v1/health` and accepts only a reply with `"status":"ok"`, `"registry_refresh":true` and Sigil's `x-sigil-request-id` header. That endpoint is unauthenticated, so this only rules out a different service on the port, not a process imitating the relay. `registryRefreshConfirmed: true` in `setup.json` is a fallback for when the relay cannot be reached: it still lets apply proceed, but the summary then prints `registry_refresh source: setup.json registryRefreshConfirmed; the relay did not confirm it`. Remove it once the relay answers, so a stale `true` cannot pass the gate.

## Apply confirmation

`--apply` requires an interactive TTY and two explicit confirmations:

1. Run:

```powershell
node sigil/scripts/phase7-setup.mjs --config "$env:USERPROFILE\.sigil-secrets\phase7\setup.json" --apply
```

2. Review the planned writes and type `APPLY PHASE7 <dbLabel>` to authorize secret storage and bot creation. `dbLabel` is only a label from `setup.json`, so first check the `database target` line above the prompt: it shows the host, port and database name from the URL in `databaseEnv` (never the user or password). If they are not the database you mean, type anything else to stop. If a `registry_refresh warning` line is shown, the relay did not confirm automatic refresh; see Dry-run above.
3. For each bot to create, type `CREATE <endpointId>` when prompted. Typing anything else declines that bot, leaves remaining bots untouched, and exits with code `4` (`partial apply`).

The live smoke run is separate: after `--apply` finishes, run the live Grok smoke check separately against the running relay.

## Partial-state recovery

If a run is interrupted (`Ctrl-C` exits with code `3`) or fails mid-apply (exit code `4`):

1. Re-run the dry-run command first to inspect each bot's state (`healthy`, `missing`, `partial`, `disabled`, or `conflict`) and confirm no setup lock remains.
2. If a bot is marked `partial` (for example, an identity file or registry entry exists without matching database rows), remove or reconcile the leftover artifact outside the database before re-running `--apply`.
3. Never delete or overwrite a `conflict` entry blindly; inspect the existing database row and registry entry first.

## One-link priority

One-link remains the active delivery track. Phase 7 owner-run setup provisions the confirmed `rewritelabs.io` bot group (`ep_grok_bot@rewritelabs.io`, `ep_first_mate@rewritelabs.io`, and `ep_floor_warden@rewritelabs.io`) without altering or delaying one-link priorities.
