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

## Dry-run

Run `phase7-setup.mjs` without `--apply` to inspect the database, registry preflight, routine secret state, and relay refresh probe without writing files, acquiring locks, or prompting:

```powershell
node sigil/scripts/phase7-setup.mjs --config "$env:USERPROFILE\.sigil-secrets\phase7\setup.json"
```

Exit code `0` means no blockers remain; exit code `2` lists missing prerequisites or blockers (such as `registry-refresh-unverified` or a repo-local path).

## Apply confirmation

`--apply` requires an interactive TTY and two explicit confirmations:

1. Run:

```powershell
node sigil/scripts/phase7-setup.mjs --config "$env:USERPROFILE\.sigil-secrets\phase7\setup.json" --apply
```

2. Review the planned writes and type `APPLY PHASE7 <dbLabel>` to authorize secret storage and bot creation.
3. For each bot to create, type `CREATE <endpointId>` when prompted. Typing anything else declines that bot, leaves remaining bots untouched, and exits with code `4` (`partial apply`).

The live smoke run is separate: after `--apply` finishes, run the live Grok smoke check separately against the running relay.

## Partial-state recovery

If a run is interrupted (`Ctrl-C` exits with code `3`) or fails mid-apply (exit code `4`):

1. Re-run the dry-run command first to inspect each bot's state (`healthy`, `missing`, `partial`, `disabled`, or `conflict`) and confirm no setup lock remains.
2. If a bot is marked `partial` (for example, an identity file or registry entry exists without matching database rows), remove or reconcile the leftover artifact outside the database before re-running `--apply`.
3. Never delete or overwrite a `conflict` entry blindly; inspect the existing database row and registry entry first.

## One-link priority

One-link remains the active delivery track. Phase 7 owner-run setup provisions the confirmed `rewritelabs.io` bot group (`ep_grok_bot@rewritelabs.io`, `ep_first_mate@rewritelabs.io`, and `ep_floor_warden@rewritelabs.io`) without altering or delaying one-link priorities.
