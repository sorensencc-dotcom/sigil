<#
.SYNOPSIS
  STOPGAP: start and supervise the local Sigil stack (relay, Chief, rooms-web) on one Windows box.

.DESCRIPTION
  Short-term stopgap for a single machine. The real fix is a cross-platform
  `sigil service install` (see the tracking issue linked in scripts/windows/README.md).

  Loads a KEY=VALUE secrets file into this process's environment without printing values,
  starts each child that is not already listening on its port, logs to .sigil\logs, and
  restarts dead children with exponential backoff. Re-running it is safe: anything already
  listening is left alone and adopted as "external".

  -WhatIf prints the planned commands (secret values masked) and exits without starting anything.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$SecretsFile = (Join-Path $env:USERPROFILE '.sigil-secrets\floor-warden.env'),
  [string]$FloorWardenBotId = '016f0b34-f0da-49b2-a32f-482d6e635825',
  [string]$ReplyUrl = 'https://sigil-ingress.rewritelabs.io',
  [string]$WrapKeyEnv = 'SIGIL_ROOM_BOT_KEY_WRAP_KEY',
  [string]$DatabaseUrlFile = (Join-Path $env:USERPROFILE '.sigil-secrets\sigil-database-url.txt'),
  [int]$RelayPort = 8791,
  [int]$IngressPort = 8796,
  [ValidateSet('relay', 'chief', 'rooms-web')][string[]]$Only = @('relay', 'chief', 'rooms-web'),
  [string]$Node = 'node',
  [int]$MaxBackoffSeconds = 300,
  [switch]$Once
)

$ErrorActionPreference = 'Stop'
if (-not $Only -or $Only.Count -eq 0) { throw "No children selected: -Only must include at least one of relay, chief, rooms-web" }
Set-Location $RepoRoot
$logDir = Join-Path $RepoRoot '.sigil\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$supervisorLog = Join-Path $logDir 'supervisor.log'

function Write-Log([string]$msg) {
  $line = '{0} {1}' -f (Get-Date -Format o), $msg
  Write-Host $line
  if (-not $WhatIfPreference) { Add-Content -Path $supervisorLog -Value $line }
}

function Import-SecretsFile([string]$path) {
  if (-not (Test-Path $path)) { throw "Secrets file not found: $path" }
  $names = @()
  foreach ($raw in Get-Content -Path $path) {
    $line = $raw.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { continue }
    if ($line.StartsWith('export ')) { $line = $line.Substring(7) }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { continue }
    $name = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    $names += $name
  }
  Write-Log ("loaded {0} secret(s) from {1}: {2}" -f $names.Count, $path, ($names -join ', '))
}

function Get-Children {
  @(
    [pscustomobject]@{ Name = 'relay'; Port = $RelayPort; Args = @(
        'sigil/cli/sigil.mjs', 'relay', 'up', '--registry', '.sigil/registry.json', '--port', "$RelayPort",
        '--federation-mode', 'queue', '--domain', 'local',
        '--federation-identity', '.sigil/grokbot.identity.json',
        '--reconcile-kind', 'ep_grokbot=agent', '--reconcile-kind', 'ep_chief=agent', '--reconcile-kind', 'ep_helix_ci=agent',
        '--room-system-identity', '.sigil/relay-system.identity.json',
        '--room-human-identity', '.sigil/antigravity.identity.json',
        '--room-bot-key-wrap-key', $WrapKeyEnv,
        '--floor-warden-reply-token-env', 'SIGIL_FLOOR_WARDEN_REPLY_TOKEN',
        '--ingress-origin', $ReplyUrl,
        '--ingress-port', "$IngressPort", '--browser-origin', 'http://127.0.0.1:5173') },
    [pscustomobject]@{ Name = 'chief'; Port = $null; Match = 'chief.identity.json'; DependsOn = 'relay'; Args = @(
        'sigil/cli/sigil.mjs', 'agent', 'run', '--identity', '.sigil/chief.identity.json',
        '--relay-url', "http://127.0.0.1:$RelayPort", '--room-bridge', 'floor-warden',
        '--floor-warden-url-env', 'SIGIL_FLOOR_WARDEN_WEBHOOK_URL',
        '--floor-warden-key-env', 'SIGIL_FLOOR_WARDEN_WEBHOOK_KEY',
        '--floor-warden-reply-url', $ReplyUrl,
        '--floor-warden-bot-id', $FloorWardenBotId,
        '--stream-url', "ws://127.0.0.1:$($RelayPort + 1)/v1/stream") },
    [pscustomobject]@{ Name = 'rooms-web'; Port = 5173; Args = @(
        'packages/sigil-rooms-web/bin/sigil-rooms-web.mjs', '--relay-url', "http://127.0.0.1:$RelayPort", '--port', '5173') }
  ) | Where-Object { $Only -contains $_.Name }
}

function Test-Running($child) {
  if ($child.Port) {
    return [bool](Get-NetTCPConnection -LocalPort $child.Port -State Listen -ErrorAction SilentlyContinue)
  }
  return [bool](Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -like "*$($child.Match)*" })
}

function Format-Args($argList) {
  ($argList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
}

function Start-Child($child) {
  $out = Join-Path $logDir "$($child.Name).out.log"
  $err = Join-Path $logDir "$($child.Name).err.log"
  Write-Log ("start {0}: {1} {2}" -f $child.Name, $Node, (Format-Args $child.Args))
  $quoted = $child.Args | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
  Start-Process -FilePath $Node -ArgumentList $quoted -WorkingDirectory $RepoRoot -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
}

if ($WhatIfPreference) {
  Write-Log "WhatIf: would load secrets from $SecretsFile (values never printed)"
  foreach ($c in Get-Children) { Write-Log ("WhatIf: {0} -> {1} {2}" -f $c.Name, $Node, (Format-Args $c.Args)) }
  return
}

Import-SecretsFile $SecretsFile
if (Test-Path $DatabaseUrlFile) {
  [Environment]::SetEnvironmentVariable('SIGIL_DATABASE_URL', (Get-Content -Raw -Path $DatabaseUrlFile).Trim(), 'Process')
  Write-Log "loaded SIGIL_DATABASE_URL from $DatabaseUrlFile"
}
foreach ($required in $WrapKeyEnv, 'SIGIL_DATABASE_URL') {
  if (-not [Environment]::GetEnvironmentVariable($required, 'Process')) { throw "$required is not set (relay ingress needs it)" }
}

$state = @{}
foreach ($c in Get-Children) { $state[$c.Name] = @{ Child = $c; Proc = $null; Backoff = 1; NextTry = [datetime]::MinValue } }

while ($true) {
  foreach ($name in @('relay', 'chief', 'rooms-web') | Where-Object { $state.ContainsKey($_) }) {
    $s = $state[$name]; $c = $s.Child
    if ($s.Proc -and -not $s.Proc.HasExited) { continue }
    if ($s.Proc -and $s.Proc.HasExited) {
      Write-Log ("{0} exited with code {1}; retry in {2}s" -f $name, $s.Proc.ExitCode, $s.Backoff)
      $s.NextTry = (Get-Date).AddSeconds($s.Backoff)
      $s.Backoff = [Math]::Min($s.Backoff * 2, $MaxBackoffSeconds)
      $s.Proc = $null
    }
    if ((Get-Date) -lt $s.NextTry) { continue }
    if ($c.DependsOn -and $state.ContainsKey($c.DependsOn) -and -not (Test-Running $state[$c.DependsOn].Child)) { continue }
    if (Test-Running $c) {
      if (-not $s.External) { Write-Log "$name already running; leaving it alone"; $s.External = $true }
      continue
    }
    $s.External = $false
    $s.Proc = Start-Child $c
    $s.StartedAt = Get-Date
  }
  foreach ($s in $state.Values) {
    if ($s.Proc -and -not $s.Proc.HasExited -and ((Get-Date) - $s.StartedAt).TotalSeconds -gt 60) { $s.Backoff = 1 }
  }
  if ($Once) { break }
  Start-Sleep -Seconds 5
}
