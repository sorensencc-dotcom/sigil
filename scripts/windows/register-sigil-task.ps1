<#
.SYNOPSIS
  DEPRECATED: register or unregister the local Sigil stack scheduled tasks.
  This stopgap script is deprecated. Use `sigil service install|uninstall` instead.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = 'SigilStack',
  [string]$SecretsFile = (Join-Path $env:USERPROFILE '.sigil-secrets\floor-warden.env'),
  [string]$Launcher,
  [string]$LauncherArguments,
  [string]$ServiceConfig,
  [string]$Node = 'node',
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
  if (Test-Path (Join-Path $loc (Join-Path 'scripts' (Join-Path 'windows' 'register-sigil-task.ps1')))) {
    $scriptDir = Join-Path $loc (Join-Path 'scripts' 'windows')
  } elseif (Test-Path (Join-Path $loc 'register-sigil-task.ps1')) {
    $scriptDir = $loc
  } else {
    $scriptDir = $loc
  }
}
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path

if ($Launcher) {
  if ($Unregister) {
    if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister scheduled task')) {
      if ($IsWindows -and (Get-Command Stop-ScheduledTask -ErrorAction SilentlyContinue)) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
      }
      Write-Host "Unregistered $TaskName (child node processes keep running; stop them by PID if needed)."
    }
    return
  }

  $user = if ($env:USERDOMAIN -and $env:USERNAME) { "$env:USERDOMAIN\$env:USERNAME" } elseif ($env:USERNAME) { $env:USERNAME } elseif ($env:USER) { $env:USER } else { 'SYSTEM' }
  $argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`" $LauncherArguments".TrimEnd()

  if ($PSCmdlet.ShouldProcess($TaskName, "Register logon task: powershell.exe $argLine")) {
    if (-not $IsWindows -or -not (Get-Command New-ScheduledTaskAction -ErrorAction SilentlyContinue)) {
      Write-Error "Scheduled tasks are only supported on Windows."
      exit 1
    }
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory (Split-Path (Split-Path $scriptDir))
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    try {
      Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
    } catch {
      Write-Error "Failed to register scheduled task ${TaskName}: $($_.Exception.Message). If the task was created from an elevated shell, rerun this from an elevated shell or delete it first."
      exit 1
    }
    $registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $registered -or -not $registered.Actions -or $registered.Actions.Count -lt 1 -or $registered.Actions[0].Execute -ne 'powershell.exe' -or $registered.Actions[0].Arguments -ne $argLine) {
      Write-Error "Failed to verify scheduled task ${TaskName}: expected Execute='powershell.exe' and Arguments='$argLine'."
      exit 1
    }
    Write-Host "Registered $TaskName for $user."
    if ($StartNow) {
      try {
        Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        Write-Host "Started $TaskName."
      } catch {
        Write-Error "Failed to start scheduled task ${TaskName}: $($_.Exception.Message)"
        exit 1
      }
    }
  }
  return
}

if (-not $ServiceConfig) { $ServiceConfig = (Join-Path $repoRoot (Join-Path '.sigil' 'service.json')) }

Write-Warning "register-sigil-task.ps1 is deprecated and replaced by 'sigil service install|uninstall'. See docs/service-config.md."

$cli = Join-Path $repoRoot (Join-Path 'bin' 'sigil.mjs')

if ($Unregister) {
  $argsList = @($cli, 'service', 'uninstall', '--service-config', $ServiceConfig)
  if ($WhatIfPreference) { $argsList += '--dry-run' }
  & $Node $argsList
  return
}

$argsList = @($cli, 'service', 'install', '--service-config', $ServiceConfig)
if ($WhatIfPreference) { $argsList += '--dry-run' }
& $Node $argsList

if ($StartNow) {
  $startArgs = @($cli, 'service', 'start', '--service-config', $ServiceConfig)
  if ($WhatIfPreference) { $startArgs += '--dry-run' }
  & $Node $startArgs
}
