<##
.SYNOPSIS
  Register the Chief watchdog as a per-user logon task.
##>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = 'SigilChiefWatchdog',
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
$watchdog = Join-Path $scriptDir 'chief-watchdog.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"
$argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`" -RepoRoot `"$repoRoot`""

if ($Unregister) {
  if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister scheduled task')) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  return
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

if ($PSCmdlet.ShouldProcess($TaskName, "Register logon task: powershell.exe $argLine")) {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
  $registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ($registered.Actions[0].Execute -ne 'powershell.exe' -or $registered.Actions[0].Arguments -ne $argLine) {
    throw "Failed to verify scheduled task $TaskName"
  }
  Write-Host "Registered $TaskName for $user."
}
