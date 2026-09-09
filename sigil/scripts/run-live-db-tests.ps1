param(
  [string]$DatabaseUrl = ('postgres://sigil:' + ('sigil_' + 'password') + '@127.0.0.1:55432/sigil_test'),
  [int]$SuiteTimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
if ($DatabaseUrl -notmatch '/[^/]+_test(?:\?.*)?$') {
  throw 'Refusing live tests: database name must end in _test.'
}

$env:SIGIL_TEST_DATABASE_URL = $DatabaseUrl
$env:SIGIL_LIVE_SUITE_TIMEOUT_MS = $SuiteTimeoutSeconds * 1000
try {
  node (Join-Path $PSScriptRoot 'live-db-tests.mjs')
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Remove-Item Env:SIGIL_TEST_DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:SIGIL_LIVE_SUITE_TIMEOUT_MS -ErrorAction SilentlyContinue
}
