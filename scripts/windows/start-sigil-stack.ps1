<#
.SYNOPSIS
  DEPRECATED: start and supervise the local Sigil stack.
  This stopgap script is deprecated. Use `sigil service start` instead.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$RepoRoot,
  [string]$SecretsFile = (Join-Path $env:USERPROFILE '.sigil-secrets\floor-warden.env'),
  [string]$FloorWardenBotId = '016f0b34-f0da-49b2-a32f-482d6e635825',
  [string]$ReplyUrl = 'https://sigil-ingress.rewritelabs.io',
  [string]$WrapKeyEnv = 'SIGIL_ROOM_BOT_KEY_WRAP_KEY',
  [string]$DatabaseUrlFile = (Join-Path $env:USERPROFILE '.sigil-secrets\sigil-database-url.txt'),
  [int]$RelayPort = 8791,
  [int]$IngressPort = 8796,
  [int]$PublicPort = 8797,
  [string]$GitHubOAuthFile = (Join-Path $env:USERPROFILE '.sigil-secrets\github-oauth.env'),
  [string]$PublicOrigin = 'https://rooms.rewritelabs.io',
  [string]$RoomKeyWrapKeyEnv = 'SIGIL_ROOM_KEY_WRAP_KEY',
  [ValidateSet('relay', 'chief', 'rooms-web')][string[]]$Only = @('relay', 'chief', 'rooms-web'),
  [string]$Node = 'node',
  [int]$MaxBackoffSeconds = 300,
  [switch]$Once,
  [string]$ServiceConfig
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\..')).Path }
if (-not $ServiceConfig) { $ServiceConfig = (Join-Path $RepoRoot '.sigil\service.json') }

Write-Warning "start-sigil-stack.ps1 is deprecated and replaced by 'sigil service start'. See docs/service-config.md."

$cli = Join-Path $RepoRoot 'bin\sigil.mjs'
$cmdArgs = @($cli, 'service', 'start', '--service-config', $ServiceConfig)
if ($WhatIfPreference) {
  $cmdArgs += '--dry-run'
}

& $Node $cmdArgs
