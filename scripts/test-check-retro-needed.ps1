#!/usr/bin/env pwsh
<# Regression tests for check-retro-needed.ps1 exit codes against a throwaway git repo. #>

$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'check-retro-needed.ps1'
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('check-retro-' + [Guid]::NewGuid())
$retroDir = Join-Path $fixtureRoot 'retros'
New-Item -ItemType Directory -Path $retroDir | Out-Null

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "FAIL: $Message" }
  Write-Host "PASS: $Message" -ForegroundColor Green
}

function Set-Retro([int]$Commits, [bool]$WithUntil) {
  Get-ChildItem $retroDir | Remove-Item -Force
  $retro = [ordered]@{
    date = '2026-10-17'; since = '2026-10-10T00:00:00Z'
    base_branch = 'main'; metrics = @{ commits = $Commits }
  }
  if ($WithUntil) { $retro.until = '2026-10-17T23:59:59Z' }
  ($retro | ConvertTo-Json -Depth 4) | Set-Content (Join-Path $retroDir '2026-10-17-1.json')
}

function Invoke-Check {
  $out = & pwsh -NoProfile -File $scriptPath -RetroDir $retroDir -Date '2026-10-17' | Out-String
  [pscustomobject]@{ Exit = $LASTEXITCODE; Output = $out }
}

Push-Location $fixtureRoot
try {
  git init -q -b main
  git config user.email 't@example.com'
  git config user.name 't'
  foreach ($i in 1..3) {
    $env:GIT_AUTHOR_DATE = $env:GIT_COMMITTER_DATE = "2026-10-12T12:0$i`:00Z"
    git commit -q --allow-empty -m "c$i"
  }
  Remove-Item Env:GIT_AUTHOR_DATE, Env:GIT_COMMITTER_DATE

  Set-Retro -Commits 3 -WithUntil $true
  $r = Invoke-Check
  Assert-True ($r.Exit -eq 1) 'equal count skips'

  Set-Retro -Commits 2 -WithUntil $true
  $r = Invoke-Check
  Assert-True ($r.Exit -eq 0 -and $r.Output -match '1 new') 'positive delta proceeds'

  Set-Retro -Commits 5 -WithUntil $true
  $r = Invoke-Check
  Assert-True ($r.Exit -eq 1) 'negative delta skips'
  Assert-True ($r.Output -match 'WARN') 'negative delta warns about baseline'

  Set-Retro -Commits 3 -WithUntil $false
  $r = Invoke-Check
  Assert-True ($r.Exit -eq 1) 'retro without until counts an open window and skips on equal'
} finally {
  Pop-Location
  if (Test-Path $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}

Write-Host 'All check-retro-needed regression tests passed.' -ForegroundColor Green
