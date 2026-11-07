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
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
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
  }
  $process = Start-Process @startParams
  Set-Content -Path $PidFile -Value $process.Id -NoNewline
  Write-Audit 'daemon_started' @{ pid = $process.Id; socket_port = $RoomSocketPort }
  return $process
}

$process = $null
$nextStart = [datetime]::MinValue
$backoff = 1
$startedAt = [datetime]::MinValue
$deadline = if ($StopAfterSeconds -gt 0) { (Get-Date).AddSeconds($StopAfterSeconds) } else { [datetime]::MaxValue }

try {
  while ((Get-Date) -lt $deadline) {
    if ($process -and $process.HasExited) {
      Write-Audit 'daemon_unhealthy' @{ reason = 'process_exited'; exit_code = $process.ExitCode }
      $process = $null
      $nextStart = (Get-Date).AddSeconds($backoff)
      $backoff = [Math]::Min($backoff * 2, $MaxBackoffSeconds)
    }
    if (-not $process -and (Get-Date) -ge $nextStart) {
      $process = Start-Chief
      $startedAt = Get-Date
      Write-Audit 'daemon_restarted' @{ pid = $process.Id; backoff_seconds = $backoff }
    } elseif ($process -and -not $process.HasExited) {
      if (((Get-Date) - $startedAt).TotalSeconds -ge $StartupGraceSeconds -and -not (Test-RoomSocket)) {
        Write-Audit 'daemon_unhealthy' @{ pid = $process.Id; reason = 'room_socket_unreachable'; socket_port = $RoomSocketPort }
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      } else {
        Write-Audit 'daemon_healthy' @{ pid = $process.Id; socket_port = $RoomSocketPort }
        $backoff = 1
      }
    }
    Start-Sleep -Milliseconds ([int]($IntervalSeconds * 1000))
  }
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  if (Test-Path $PidFile) { Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue }
  Write-Audit 'watchdog_stopped'
}
