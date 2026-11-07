<#
.SYNOPSIS
  Register (or -Unregister) the Chief watchdog as a per-user logon task.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = 'SigilChiefWatchdog',
  [string]$RepoRoot,
  [switch]$Unregister,
  [switch]$StartNow
)
$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
if (-not $scriptDir -and $PSCommandPath) {
  $scriptDir = Split-Path -Parent $PSCommandPath
}
if (-not $scriptDir -and $MyInvocation -and $MyInvocation.PSCommandPath) {
  $scriptDir = Split-Path -Parent $MyInvocation.PSCommandPath
}
if (-not $scriptDir -and $MyInvocation -and $MyInvocation.MyCommand -and $MyInvocation.MyCommand.Path) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if (-not $scriptDir) {
  $loc = (Get-Location).Path
  if (Test-Path (Join-Path $loc (Join-Path 'scripts' 'chief-watchdog.ps1'))) {
    $scriptDir = Join-Path $loc 'scripts'
  } elseif (Test-Path (Join-Path $loc 'chief-watchdog.ps1')) {
    $scriptDir = $loc
  } else {
    $scriptDir = $loc
  }
}

if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
}
$registerScript = Join-Path $scriptDir (Join-Path 'windows' 'register-sigil-task.ps1')
$watchdogScript = Join-Path $scriptDir 'chief-watchdog.ps1'

& $registerScript -TaskName $TaskName `
  -Launcher $watchdogScript -LauncherArguments "-RepoRoot `"$RepoRoot`"" `
  -Unregister:$Unregister -StartNow:$StartNow -WhatIf:$WhatIfPreference
if ($LASTEXITCODE) { exit $LASTEXITCODE }
