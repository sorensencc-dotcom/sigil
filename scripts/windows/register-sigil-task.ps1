<#
.SYNOPSIS
  STOPGAP: register (or -Unregister) a per-user logon scheduled task that runs start-sigil-stack.ps1.
  Runs as the current user with limited rights, so no admin shell is needed.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = 'SigilStack',
  [string]$SecretsFile = (Join-Path $env:USERPROFILE '.sigil-secrets\floor-warden.env'),
  [switch]$Unregister,
  [switch]$StartNow
)
$ErrorActionPreference = 'Stop'

if ($Unregister) {
  if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister scheduled task')) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Unregistered $TaskName (child node processes keep running; stop them by PID if needed)."
  }
  return
}

$launcher = Join-Path $PSScriptRoot 'start-sigil-stack.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"
$argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" -SecretsFile `"$SecretsFile`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory (Split-Path (Split-Path $PSScriptRoot))
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

if ($PSCmdlet.ShouldProcess($TaskName, "Register logon task: powershell.exe $argLine")) {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "Registered $TaskName for $user."
  if ($StartNow) { Start-ScheduledTask -TaskName $TaskName; Write-Host "Started $TaskName." }
}
