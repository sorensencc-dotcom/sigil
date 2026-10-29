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

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $scriptDir 'start-sigil-stack.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"
$argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" -SecretsFile `"$SecretsFile`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory (Split-Path (Split-Path $scriptDir))
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

if ($PSCmdlet.ShouldProcess($TaskName, "Register logon task: powershell.exe $argLine")) {
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
