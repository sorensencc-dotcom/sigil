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

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
& (Join-Path $scriptDir 'windows\register-sigil-task.ps1') -TaskName $TaskName `
  -Launcher (Join-Path $scriptDir 'chief-watchdog.ps1') -LauncherArguments "-RepoRoot `"$repoRoot`"" `
  -Unregister:$Unregister -StartNow:$StartNow -WhatIf:$WhatIfPreference
exit $LASTEXITCODE
