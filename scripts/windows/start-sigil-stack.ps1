<#
.SYNOPSIS
  DEPRECATED: start and supervise the local Sigil stack.
  This stopgap script is deprecated. Use `sigil service start` instead.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$RepoRoot,
  [string]$SecretsFile,
  [string]$FloorWardenBotId = '016f0b34-f0da-49b2-a32f-482d6e635825',
  [string]$ReplyUrl = 'https://sigil-ingress.rewritelabs.io',
  [string]$WrapKeyEnv = 'SIGIL_ROOM_BOT_KEY_WRAP_KEY',
  [string]$DatabaseUrlFile,
  [int]$RelayPort = 8791,
  [int]$IngressPort = 8796,
  [int]$PublicPort = 8797,
  [string]$GitHubOAuthFile,
  [string]$PublicOrigin = 'https://rooms.rewritelabs.io',
  [string]$RoomKeyWrapKeyEnv = 'SIGIL_ROOM_KEY_WRAP_KEY',
  [ValidateSet('relay', 'chief', 'rooms-web')][string[]]$Only = @('relay', 'chief', 'rooms-web'),
  [string]$Node = 'node',
  [int]$MaxBackoffSeconds = 300,
  [switch]$Once,
  [string]$ServiceConfig
)

$ErrorActionPreference = 'Stop'
$homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($HOME) { $HOME } else { '.' }
if (-not $SecretsFile) { $SecretsFile = Join-Path $homeDir (Join-Path '.sigil-secrets' 'floor-warden.env') }
if (-not $DatabaseUrlFile) { $DatabaseUrlFile = Join-Path $homeDir (Join-Path '.sigil-secrets' 'sigil-database-url.txt') }
if (-not $GitHubOAuthFile) { $GitHubOAuthFile = Join-Path $homeDir (Join-Path '.sigil-secrets' 'github-oauth.env') }
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\..')).Path }
if (-not $ServiceConfig) { $ServiceConfig = (Join-Path $RepoRoot '.sigil\service.json') }

Write-Warning "start-sigil-stack.ps1 is deprecated and replaced by 'sigil service start'. See docs/service-config.md."

$cli = Join-Path $RepoRoot 'bin\sigil.mjs'
$cmdArgs = @($cli, 'service', 'start', '--service-config', $ServiceConfig)
if ($WhatIfPreference) {
  $cmdArgs += '--dry-run'
}

& $Node $cmdArgs
