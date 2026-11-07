[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Install', 'Start', 'Stop', 'Status', 'Uninstall')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$PlanJson
)

$ErrorActionPreference = 'Stop'

$plan = $PlanJson | ConvertFrom-Json
$user = "$env:USERDOMAIN\$env:USERNAME"

function Get-ListeningPorts {
  try {
    return @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort)
  } catch {
    return @()
  }
}

function Get-ProcessPidByPort([int]$port) {
  try {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return $conn.OwningProcess }
  } catch {}
  return $null
}

if ($Action -eq 'Install') {
  $results = @()
  foreach ($comp in $plan.components) {
    $taskName = $comp.supervisor.task_name
    $outLog = $comp.log_files.out
    $errLog = $comp.log_files.err

    # Ensure log directory exists
    $logDir = Split-Path -Parent $outLog
    if (-not (Test-Path $logDir)) {
      New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    }

    $cmd = $comp.command -join ' '
    $runnerScript = "& $cmd *>> `"$outLog`" 2>> `"$errLog`""
    $argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"$runnerScript`""

    $taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

    if ($PSCmdlet.ShouldProcess($taskName, "Register scheduled task")) {
      Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
    }
    $results += [pscustomobject]@{
      Component = $comp.name
      TaskName = $taskName
      Status = 'Installed'
    }
  }
  $results | ConvertTo-Json -Depth 4
  exit 0
}

if ($Action -eq 'Start') {
  $results = @()
  foreach ($comp in $plan.components) {
    $taskName = $comp.supervisor.task_name
    if ($PSCmdlet.ShouldProcess($taskName, "Start scheduled task")) {
      try {
        Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
        $results += [pscustomobject]@{ Component = $comp.name; TaskName = $taskName; Status = 'Started' }
      } catch {
        $results += [pscustomobject]@{ Component = $comp.name; TaskName = $taskName; Status = 'StartFailed'; Error = $_.Exception.Message }
      }
    }
  }
  $results | ConvertTo-Json -Depth 4
  exit 0
}

if ($Action -eq 'Stop') {
  $results = @()
  foreach ($comp in $plan.components) {
    $taskName = $comp.supervisor.task_name
    if ($PSCmdlet.ShouldProcess($taskName, "Stop scheduled task")) {
      try {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        # If port is still bound, terminate process
        foreach ($p in $comp.ports) {
          $pidToKill = Get-ProcessPidByPort $p
          if ($pidToKill) {
            Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
          }
        }
        $results += [pscustomobject]@{ Component = $comp.name; TaskName = $taskName; Status = 'Stopped' }
      } catch {
        $results += [pscustomobject]@{ Component = $comp.name; TaskName = $taskName; Status = 'StopFailed'; Error = $_.Exception.Message }
      }
    }
  }
  $results | ConvertTo-Json -Depth 4
  exit 0
}

if ($Action -eq 'Status') {
  $listeningPorts = Get-ListeningPorts
  $results = @()
  foreach ($comp in $plan.components) {
    $taskName = $comp.supervisor.task_name
    $taskInfo = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $taskState = if ($taskInfo) { $taskInfo.State.ToString() } else { 'NotInstalled' }

    $boundPorts = @($comp.ports | Where-Object { $listeningPorts -contains $_ })
    $pids = @()
    foreach ($p in $boundPorts) {
      $foundPid = Get-ProcessPidByPort $p
      if ($foundPid -and $pids -notcontains $foundPid) { $pids += $foundPid }
    }

    # Check last error from errLog
    $lastError = $null
    if (Test-Path $comp.log_files.err) {
      $errLines = Get-Content -Path $comp.log_files.err -Tail 5 -ErrorAction SilentlyContinue
      if ($errLines) { $lastError = ($errLines -join "`n").Trim() }
    }

    $isHealthy = if ($comp.ports.Count -gt 0) {
      ($boundPorts.Count -eq $comp.ports.Count) -and ($taskState -eq 'Running' -or $taskState -eq 'Ready')
    } else {
      ($taskState -eq 'Running' -or $taskState -eq 'Ready')
    }

    $results += [pscustomobject]@{
      Component = $comp.name
      TaskName = $taskName
      TaskState = $taskState
      Healthy = [bool]$isHealthy
      ListeningPorts = $boundPorts
      ExpectedPorts = $comp.ports
      Pids = $pids
      LastError = $lastError
    }
  }
  $results | ConvertTo-Json -Depth 4
  exit 0
}

if ($Action -eq 'Uninstall') {
  $results = @()
  foreach ($comp in $plan.components) {
    $taskName = $comp.supervisor.task_name
    if ($PSCmdlet.ShouldProcess($taskName, "Unregister scheduled task")) {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
      $results += [pscustomobject]@{ Component = $comp.name; TaskName = $taskName; Status = 'Uninstalled' }
    }
  }
  $results | ConvertTo-Json -Depth 4
  exit 0
}
