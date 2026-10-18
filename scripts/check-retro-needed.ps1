#!/usr/bin/env pwsh
<#
.SYNOPSIS
Gate a same-day /retro run: skip if no commits landed since the last same-day retro.

.DESCRIPTION
Finds the latest .context/retros/<today>-N.json file, re-counts commits in its
[since, until) window on its base_branch, and compares against that file's
recorded metrics.commits. If the count is unchanged, exits 1 (SKIP) so a
session doesn't burn a retro write on zero new work. If counts differ, or no
same-day retro exists yet, exits 0 (PROCEED).

Also warns when the newest dated retro in the directory is at least
-MaxAgeDays old (default 7, matching retro-full-audit.yml).

.PARAMETER RetroDir
Directory containing dated retro JSON files. Defaults to .context/retros.
#>

param(
  [string]$RetroDir = ".context/retros",
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [int]$MaxAgeDays = 7
)

$today = $Date

$newest = Get-ChildItem -Path $RetroDir -Filter "*.json" -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}-\d+\.json$' } |
  Sort-Object { [DateTime]::ParseExact($_.BaseName.Substring(0, 10), 'yyyy-MM-dd', $null) } |
  Select-Object -Last 1

if ($newest) {
  $newestDate = [DateTime]::ParseExact($newest.BaseName.Substring(0, 10), 'yyyy-MM-dd', $null)
  $ageDays = ([DateTime]::ParseExact($today, 'yyyy-MM-dd', $null) - $newestDate).Days
  if ($ageDays -ge $MaxAgeDays) {
    Write-Host "WARN: newest retro $($newest.Name) is $ageDays days old (limit $MaxAgeDays); retro-full-audit fails past $MaxAgeDays."
  }
}

$todayFiles = Get-ChildItem -Path $RetroDir -Filter "$today-*.json" -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match "^$today-(\d+)\.json$" } |
  Sort-Object { [int]($_.Name -replace "^$today-(\d+)\.json$", '$1') }

if (-not $todayFiles -or $todayFiles.Count -eq 0) {
  Write-Host "PROCEED: no retro filed today yet."
  exit 0
}

$lastFile = $todayFiles[-1]
$data = Get-Content $lastFile.FullName -Raw | ConvertFrom-Json

function ConvertTo-GitUtc($value) {
  if ($value -is [DateTime]) { return $value.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss") + "Z" }
  return [string]$value
}

$since = ConvertTo-GitUtc $data.since
$until = ConvertTo-GitUtc $data.until
$branch = $data.base_branch
$priorCommits = $data.metrics.commits

$gitArgs = @($branch, "--since=$since")
if ($until) { $gitArgs += "--until=$until" }
$currentCommits = (git log @gitArgs --oneline 2>$null | Measure-Object -Line).Lines

if ($null -eq $currentCommits) { $currentCommits = 0 }

$delta = $currentCommits - $priorCommits

if ($delta -lt 0) {
  Write-Host "WARN: window on $branch holds $currentCommits commits but $($lastFile.Name) recorded $priorCommits; baseline was counted differently or history was rewritten."
}

if ($delta -le 0) {
  Write-Host "SKIP: no new commits since $($lastFile.Name) ($currentCommits now vs $priorCommits recorded on $branch)."
  exit 1
}

Write-Host "PROCEED: $currentCommits commits/window vs $priorCommits at $($lastFile.Name) ($delta new)."
exit 0
