<##
.SYNOPSIS
  Keep the Chief daemon and its room stream socket alive.

.DESCRIPTION
  The default probe interval is 60 seconds. The PID and socket are local
  liveness signals; audit entries contain state and numeric metadata only.
##>
[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$DaemonPath = 'node',
  [string[]]$DaemonArguments = @('sigil/cli/sigil.mjs', 'agent', 'run', '--identity', '.sigil/chief.identity.json', '--relay-url', 'http://127.0.0.1:8791', '--room-bridge', 'floor-warden', '--stream-url', 'ws://127.0.0.1:8792/v1/stream'),
  [string]$PidFile,
  [string]$AuditLogPath,
  [string]$RoomSocketHost = '127.0.0.1',
  [int]$RoomSocketPort = 8792,
  [double]$IntervalSeconds = 60,
  [double]$StartupGraceSeconds = 60,
  [int]$MaxBackoffSeconds = 300,
  [int]$StopAfterSeconds = 0
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
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
  $RepoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
}
if (-not $PidFile) { $PidFile = Join-Path $RepoRoot (Join-Path '.sigil' 'chief.pid') }
if (-not $AuditLogPath) { $AuditLogPath = Join-Path $RepoRoot (Join-Path '.sigil' (Join-Path 'logs' 'audit.log')) }
if ($IntervalSeconds -le 0) { throw 'IntervalSeconds must be greater than zero' }
Set-Location $RepoRoot
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PidFile), (Split-Path -Parent $AuditLogPath) | Out-Null

function Write-Audit([string]$event, [hashtable]$data = @{}) {
  $record = [ordered]@{ timestamp = (Get-Date).ToUniversalTime().ToString('o'); component = 'chief-watchdog'; event = $event }
  foreach ($key in $data.Keys) { $record[$key] = $data[$key] }
  Add-Content -Path $AuditLogPath -Value ($record | ConvertTo-Json -Compress)
}

function Test-RoomSocket {
  if ($RoomSocketPort -le 0) { return $true }
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($RoomSocketHost, $RoomSocketPort, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(1000)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch { return $false } finally { $client.Close() }
}

function Start-Chief {
  $startParams = @{
    FilePath = $DaemonPath
    ArgumentList = $DaemonArguments
    WorkingDirectory = $RepoRoot
    PassThru = $true
  }
  if ($IsWindows) {
    $startParams['WindowStyle'] = 'Hidden'
  } else {
    # On Linux, Start-Process children inherit pwsh stdio. A piped stderr in
    # `node --test` then keeps the file from exiting after pwsh is killed.
    $logDir = Split-Path -Parent $PidFile
    $outLog = Join-Path $logDir 'chief.watchdog.out.log'
    $errLog = Join-Path $logDir 'chief.watchdog.err.log'
    foreach ($log in @($outLog, $errLog)) {
      if (Test-Path -LiteralPath $log) { Remove-Item -LiteralPath $log -Force }
    }
    $startParams['RedirectStandardOutput'] = $outLog
    $startParams['RedirectStandardError'] = $errLog
  }
  $started = Start-Process @startParams
  Set-Content -Path $PidFile -Value $started.Id -NoNewline
  Write-Audit 'daemon_started' @{ pid = $started.Id; socket_port = $RoomSocketPort }
  return $started
}

function Stop-ChiefFromPidFile {
  # ProcessExit / POSIX callbacks close over $process at $null; the PID file is
  # the source of truth for the Start-Process grandchild.
  $file = $script:pidFilePath
  if ($file -and (Test-Path -LiteralPath $file)) {
    $daemonPid = 0
    [void][int]::TryParse("$(Get-Content -LiteralPath $file -ErrorAction SilentlyContinue)", [ref]$daemonPid)
    if ($daemonPid -gt 0) { Stop-Process -Id $daemonPid -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
  if ($script:process -and -not $script:process.HasExited) {
    Stop-Process -Id $script:process.Id -Force -ErrorAction SilentlyContinue
  }
}

$script:process = $null
$script:stopping = $false
$script:pidFilePath = $PidFile
try {
  [System.AppDomain]::CurrentDomain.add_ProcessExit({ Stop-ChiefFromPidFile })
} catch {}
try {
  if (-not $IsWindows) {
    $onPosixStop = {
      param($ctx)
      $ctx.Cancel = $true
      $script:stopping = $true
      Stop-ChiefFromPidFile
      [Environment]::Exit(0)
    }
    foreach ($sigName in @('SIGTERM', 'SIGINT', 'SIGHUP')) {
      try {
        $null = [System.Runtime.InteropServices.PosixSignalRegistration]::Create(
          [System.Runtime.InteropServices.PosixSignal]$sigName,
          $onPosixStop
        )
      } catch {}
    }
  }
} catch {}
$nextStart = [datetime]::MinValue
$backoff = 1
$startedAt = [datetime]::MinValue
$deadline = if ($StopAfterSeconds -gt 0) { (Get-Date).AddSeconds($StopAfterSeconds) } else { [datetime]::MaxValue }

try {
  while (-not $script:stopping -and (Get-Date) -lt $deadline) {
    if ($script:process -and $script:process.HasExited) {
      Write-Audit 'daemon_unhealthy' @{ reason = 'process_exited'; exit_code = $script:process.ExitCode }
      $script:process = $null
      $nextStart = (Get-Date).AddSeconds($backoff)
      $backoff = [Math]::Min($backoff * 2, $MaxBackoffSeconds)
    }
    if (-not $script:process -and (Get-Date) -ge $nextStart) {
      $script:process = Start-Chief
      $startedAt = Get-Date
      Write-Audit 'daemon_restarted' @{ pid = $script:process.Id; backoff_seconds = $backoff }
    } elseif ($script:process -and -not $script:process.HasExited) {
      if (((Get-Date) - $startedAt).TotalSeconds -ge $StartupGraceSeconds -and -not (Test-RoomSocket)) {
        Write-Audit 'daemon_unhealthy' @{ pid = $script:process.Id; reason = 'room_socket_unreachable'; socket_port = $RoomSocketPort }
        Stop-Process -Id $script:process.Id -Force -ErrorAction SilentlyContinue
      } else {
        Write-Audit 'daemon_healthy' @{ pid = $script:process.Id; socket_port = $RoomSocketPort }
        $backoff = 1
      }
    }
    $sliceMs = [Math]::Min(200, [int]($IntervalSeconds * 1000))
    $slept = 0
    $totalSleep = [int]($IntervalSeconds * 1000)
    while (-not $script:stopping -and $slept -lt $totalSleep -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds $sliceMs
      $slept += $sliceMs
    }
  }
} finally {
  Stop-ChiefFromPidFile
  Write-Audit 'watchdog_stopped'
}
