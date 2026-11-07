<#
.SYNOPSIS
  Register (or -Unregister) the Chief watchdog as a per-user logon task.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = 'SigilChiefWatchdog',
  [switch]$Unregister,
  [switch]$StartNow
)
$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
$registerScript = Join-Path $scriptDir (Join-Path 'windows' 'register-sigil-task.ps1')
$watchdogScript = Join-Path $scriptDir 'chief-watchdog.ps1'

& $registerScript -TaskName $TaskName `
  -Launcher $watchdogScript -LauncherArguments "-RepoRoot `"$repoRoot`"" `
  -Unregister:$Unregister -StartNow:$StartNow -WhatIf:$WhatIfPreference
if ($LASTEXITCODE) { exit $LASTEXITCODE }
