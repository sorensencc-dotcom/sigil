[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Install', 'Start', 'Stop', 'Status', 'Uninstall')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$PlanBase64
)

$ErrorActionPreference = 'Stop'

$plan = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PlanBase64)) | ConvertFrom-Json
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

# Runner processes are `node ... service run <component> ...`. Match on that
# token so stop/status work for components that listen on no port (agents).
function Get-RunnerPids([string]$component) {
  try {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "* service run $component *" } |
        Select-Object -ExpandProperty ProcessId)
  } catch {
    return @()
  }
}

function Get-ScheduledTaskIfPresent([string]$taskName) {
  try {
    return Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  } catch {
    if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound_TaskName,*') { return $null }
    throw
  }
}

if ($Action -eq 'Install') {
  $logonType = if ($plan.supervisor -and $plan.supervisor.logon_type -eq 's4u') { 'S4U' } else { 'Interactive' }
  $runLevel = if ($plan.supervisor -and $plan.supervisor.run_level -eq 'highest') { 'Highest' } else { 'Limited' }
  $startAtStartup = [bool]($plan.supervisor -and $plan.supervisor.start_at_startup -eq $true)
  $startWhenAvailable = [bool]($plan.supervisor -and $plan.supervisor.start_when_available -eq $true)
  $results = @()
  foreach ($comp in $plan.components) {
    $taskName = $comp.supervisor_target.task_name
    $outLog = $comp.log_files.out

    # Ensure log directory exists
    $logDir = Split-Path -Parent $outLog
    if (-not (Test-Path $logDir)) {
      New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    }

    # The task runs `sigil service run <component>` directly (no shell wrapper):
    # that runner loads secrets, waits for dependencies, writes the logs and
    # restarts the child. Relative paths in the child command resolve against
    # the working directory, so it must be the project root.
    $taskAction = New-ScheduledTaskAction -Execute $comp.task.execute -Argument $comp.task.arguments -WorkingDirectory $comp.task.working_directory
    # AtLogOn always stays; AtStartup is added only on opt-in.
    $trigger = @(New-ScheduledTaskTrigger -AtLogOn -User $user)
    $triggerNames = @('AtLogOn')
    if ($startAtStartup) {
      $trigger += New-ScheduledTaskTrigger -AtStartup
      $triggerNames += 'AtStartup'
    }
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType $logonType -RunLevel $runLevel
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    if ($startWhenAvailable) { $settings.StartWhenAvailable = $true }

    if ($PSCmdlet.ShouldProcess($taskName, "Register scheduled task")) {
      Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
    }
    $results += [pscustomobject]@{
      Component = $comp.name
      TaskName = $taskName
      Status = 'Installed'
      WorkingDirectory = $taskAction.WorkingDirectory
      LogonType = $principal.LogonType.ToString()
      RunLevel = $principal.RunLevel.ToString()
      Triggers = @($triggerNames)
      StartWhenAvailable = [bool]$settings.StartWhenAvailable
    }
  }
  ConvertTo-Json -InputObject @($results) -Depth 4
  exit 0
}

if ($Action -eq 'Start') {
  $results = @()
  foreach ($comp in $plan.components) {
    $taskName = $comp.supervisor_target.task_name
    if ($PSCmdlet.ShouldProcess($taskName, "Start scheduled task")) {
      try {
        Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
        $results += [pscustomobject]@{ Component = $comp.name; TaskName = $taskName; Status = 'Started' }
      } catch {
        $results += [pscustomobject]@{ Component = $comp.name; TaskName = $taskName; Status = 'StartFailed'; Error = $_.Exception.Message }
      }
    }
  }
  ConvertTo-Json -InputObject @($results) -Depth 4
  exit 0
}

if ($Action -eq 'Stop') {
  $results = @()
  foreach ($comp in $plan.components) {
    $taskName = $comp.supervisor_target.task_name
    if ($PSCmdlet.ShouldProcess($taskName, "Stop scheduled task")) {
      try {
        # Find the runner before stopping the task: Stop-ScheduledTask ends the
        # runner but leaves its node child running, so kill the whole tree.
        $runnerPids = Get-RunnerPids $comp.name
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        foreach ($runnerPid in $runnerPids) {
          & taskkill.exe /PID $runnerPid /T /F 2>&1 | Out-Null
        }
        # If a port is still bound (process started outside the task), terminate it
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
  ConvertTo-Json -InputObject @($results) -Depth 4
  exit 0
}

if ($Action -eq 'Status') {
  $listeningPorts = Get-ListeningPorts
  $results = @()
  foreach ($comp in $plan.components) {
    $taskName = $comp.supervisor_target.task_name
    $taskInfo = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $taskState = if ($taskInfo) { $taskInfo.State.ToString() } else { 'NotInstalled' }

    $boundPorts = @($comp.ports | Where-Object { $listeningPorts -contains $_ })
    $pids = @(Get-RunnerPids $comp.name)
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

    # A task in state Ready is installed but not running: never healthy.
    $isHealthy = ($taskState -eq 'Running') -and ($boundPorts.Count -eq @($comp.ports).Count)

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
  ConvertTo-Json -InputObject @($results) -Depth 4
  exit 0
}

if ($Action -eq 'Uninstall') {
  $results = @()
  foreach ($comp in $plan.components) {
    $taskName = $comp.supervisor_target.task_name
    if ($PSCmdlet.ShouldProcess($taskName, "Unregister scheduled task")) {
      $task = Get-ScheduledTaskIfPresent $taskName
      if ($task) {
        if ($task.State.ToString() -eq 'Running') {
          Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
        }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
        if (Get-ScheduledTaskIfPresent $taskName) {
          throw "Scheduled task $taskName is still registered after uninstall."
        }
      }
      $results += [pscustomobject]@{ Component = $comp.name; TaskName = $taskName; Status = 'Uninstalled' }
    }
  }
  ConvertTo-Json -InputObject @($results) -Depth 4
  exit 0
}
