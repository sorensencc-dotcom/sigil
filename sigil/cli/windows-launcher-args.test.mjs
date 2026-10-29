import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RELAY_UP_OPTIONS, AGENT_RUN_OPTIONS } from './sigil.mjs';

const root = new URL('../../', import.meta.url);
const rootPath = fileURLToPath(root);
const scriptPath = fileURLToPath(new URL('scripts/windows/start-sigil-stack.ps1', root));
const registerScriptPath = fileURLToPath(new URL('scripts/windows/register-sigil-task.ps1', root));
const script = readFileSync(scriptPath, 'utf8');
const roomsWebSource = readFileSync(new URL('packages/sigil-rooms-web/bin/sigil-rooms-web.mjs', root), 'utf8');

const paramDefaults = Object.fromEntries(
  [...script.matchAll(/\[(?:string|int)\]\$(\w+) = '?([^',\n]+)'?,?\n/g)].map(([, name, value]) => [name, value]),
);

function expand(token) {
  if (token.startsWith("'")) return token.slice(1, -1);
  const inner = token.startsWith('"') ? token.slice(1, -1) : token;
  return inner
    .replace(/\$\(\$(\w+) \+ (\d+)\)/g, (_, v, n) => String(Number(paramDefaults[v]) + Number(n)))
    .replace(/\$(\w+)/g, (_, v) => {
      assert.ok(v in paramDefaults, `launcher references $${v} with no literal param default`);
      return paramDefaults[v];
    });
}

function plannedArgv(name) {
  const block = script.match(new RegExp(`Name = '${name}';[^\\n]*Args = @\\(([\\s\\S]*?)\\) \\}`));
  assert.ok(block, `launcher defines ${name}`);
  return [...block[1].matchAll(/'[^']*'|"[^"]*"|\$\w+/g)].map(([t]) => expand(t));
}

test('launcher relay argv parses under sigil relay up', () => {
  const [entry, cmd, sub, ...rest] = plannedArgv('relay');
  assert.deepEqual([entry, cmd, sub], ['sigil/cli/sigil.mjs', 'relay', 'up']);
  const { values } = parseArgs({ args: rest, options: RELAY_UP_OPTIONS });
  assert.match(values['room-bot-key-wrap-key'], /^[A-Z][A-Z0-9_]*$/, 'wrap key is passed by env var name, never by value');
  assert.ok(values['ingress-origin'], 'relay gets --ingress-origin');
});

test('launcher chief argv parses under sigil agent run', () => {
  const [entry, cmd, sub, ...rest] = plannedArgv('chief');
  assert.deepEqual([entry, cmd, sub], ['sigil/cli/sigil.mjs', 'agent', 'run']);
  const { values } = parseArgs({ args: rest, options: AGENT_RUN_OPTIONS });
  assert.ok(values['floor-warden-reply-url']);
});

test('launcher rooms-web flags are known to sigil-rooms-web', () => {
  const [entry, ...rest] = plannedArgv('rooms-web');
  assert.equal(entry, 'packages/sigil-rooms-web/bin/sigil-rooms-web.mjs');
  for (const flag of rest.filter((a) => a.startsWith('--'))) {
    const name = flag.slice(2);
    assert.ok(roomsWebSource.includes(`'${name}':`) || roomsWebSource.includes(`  ${name}:`), `rooms-web knows ${flag}`);
  }
});

test('no ps1 under scripts/windows references $PSScriptRoot inside param()', () => {
  const winDir = join(rootPath, 'scripts', 'windows');
  const ps1Files = readdirSync(winDir).filter((f) => f.endsWith('.ps1'));
  assert.ok(ps1Files.length > 0, 'found ps1 files under scripts/windows');
  for (const file of ps1Files) {
    const src = readFileSync(join(winDir, file), 'utf8');
    const paramBlock = src.match(/param\([\s\S]*?\n\)/);
    if (paramBlock) {
      assert.doesNotMatch(paramBlock[0], /\$PSScriptRoot/, `${file} must not use $PSScriptRoot inside param()`);
    }
  }
});

function findPowerShell() {
  const candidates = process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh'];
  for (const cmd of candidates) {
    const res = spawnSync(cmd, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (!res.error && res.status === 0 && /^\d+/.test((res.stdout || '').trim())) {
      return cmd;
    }
  }
  return null;
}

const psHost = findPowerShell();

test('launcher resolves RepoRoot when Windows PowerShell 5.1 runs it via -File', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows PowerShell 5.1 only exists on Windows');
  const tmp = mkdtempSync(join(tmpdir(), 'sigil-ps-test-'));
  const cwdTmp = mkdtempSync(join(tmpdir(), 'sigil-ps-cwd-'));
  try {
    const scriptsWin = join(tmp, 'scripts', 'windows');
    mkdirSync(scriptsWin, { recursive: true });
    const copiedLauncher = join(scriptsWin, 'start-sigil-stack.ps1');
    copyFileSync(scriptPath, copiedLauncher);
    const missingEnv = join(tmp, 'missing.env');
    const res = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', copiedLauncher, '-SecretsFile', missingEnv],
      { cwd: cwdTmp, encoding: 'utf8', env: { ...process.env, USERPROFILE: tmp } },
    );
    const combined = `${res.stdout || ''}\n${res.stderr || ''}`;
    assert.doesNotMatch(combined, /Cannot bind argument to parameter 'Path'/);
    assert.notEqual(res.status, 0, combined);
    assert.match(combined, /Secrets file not found/, 'stopped at the secrets check, before spawning anything');
    assert.ok(existsSync(join(tmp, '.sigil', 'logs')), 'RepoRoot resolved to the copied script tree');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(cwdTmp, { recursive: true, force: true });
  }
});

test('register-sigil-task fails loudly when Register-ScheduledTask throws', (t) => {
  if (!psHost) return t.skip('no PowerShell host available');
  const tmp = mkdtempSync(join(tmpdir(), 'sigil-reg-fail-'));
  try {
    const cmd = `
      function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory, [Parameter(ValueFromRemainingArguments)]$rest) [pscustomobject]@{ Execute = $Execute; Arguments = $Argument } }
      function New-ScheduledTaskTrigger { param([Parameter(ValueFromRemainingArguments)]$rest) [pscustomobject]@{} }
      function New-ScheduledTaskPrincipal { param([Parameter(ValueFromRemainingArguments)]$rest) [pscustomobject]@{} }
      function New-ScheduledTaskSettingsSet { param([Parameter(ValueFromRemainingArguments)]$rest) [pscustomobject]@{} }
      function Register-ScheduledTask { param($TaskName, $Action, $Trigger, $Principal, $Settings, [switch]$Force, [Parameter(ValueFromRemainingArguments)]$rest) throw 'Access is denied.' }
      function Get-ScheduledTask { param($TaskName, [Parameter(ValueFromRemainingArguments)]$rest) return $null }
      function Start-ScheduledTask { param($TaskName, [Parameter(ValueFromRemainingArguments)]$rest) }
      & '${registerScriptPath.replace(/'/g, "''")}' -StartNow
      exit $LASTEXITCODE
    `;
    const res = spawnSync(psHost, ['-NoProfile', '-Command', cmd], {
      cwd: tmp,
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: tmp, USERDOMAIN: 'TESTDOM', USERNAME: 'testuser' },
    });
    const combined = `${res.stdout || ''}\n${res.stderr || ''}`;
    assert.notEqual(res.status, 0, combined);
    assert.match(combined, /Access\s+is\s+denied/);
    assert.doesNotMatch(combined, /Registered/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('register-sigil-task exits 1 when Register-ScheduledTask writes a non-terminating error', (t) => {
  if (!psHost) return t.skip('no PowerShell host available');
  const tmp = mkdtempSync(join(tmpdir(), 'sigil-reg-nonterm-'));
  try {
    const cmd = `
      function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory, [Parameter(ValueFromRemainingArguments)]$rest) $global:a = [pscustomobject]@{ Execute = $Execute; Arguments = $Argument }; $global:a }
      function New-ScheduledTaskTrigger { param([Parameter(ValueFromRemainingArguments)]$rest) [pscustomobject]@{} }
      function New-ScheduledTaskPrincipal { param([Parameter(ValueFromRemainingArguments)]$rest) [pscustomobject]@{} }
      function New-ScheduledTaskSettingsSet { param([Parameter(ValueFromRemainingArguments)]$rest) [pscustomobject]@{} }
      New-Module -Name FakeScheduledTasks -ScriptBlock {
        function Register-ScheduledTask { [CmdletBinding()] param($TaskName, $Action, $Trigger, $Principal, $Settings, [switch]$Force) Write-Error 'Access is denied.' }
        Export-ModuleMember -Function Register-ScheduledTask
      } | Import-Module
      function Get-ScheduledTask { param($TaskName, [Parameter(ValueFromRemainingArguments)]$rest) [pscustomobject]@{ Actions = @($global:a) } }
      function Start-ScheduledTask { param($TaskName, [Parameter(ValueFromRemainingArguments)]$rest) }
      & '${registerScriptPath.replace(/'/g, "''")}' -StartNow
      exit $LASTEXITCODE
    `;
    const res = spawnSync(psHost, ['-NoProfile', '-Command', cmd], {
      cwd: tmp,
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: tmp, USERDOMAIN: 'TESTDOM', USERNAME: 'testuser' },
    });
    const combined = `${res.stdout || ''}\n${res.stderr || ''}`;
    assert.equal(res.status, 1, combined);
    assert.match(combined, /Access\s+is\s+denied/);
    assert.doesNotMatch(combined, /Registered|Started/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('register-sigil-task verifies registered task action and succeeds', (t) => {
  if (!psHost) return t.skip('no PowerShell host available');
  const tmp = mkdtempSync(join(tmpdir(), 'sigil-reg-ok-'));
  try {
    const cmd = `
      function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory, [Parameter(ValueFromRemainingArguments)]$rest) [pscustomobject]@{ Execute = $Execute; Arguments = $Argument } }
      function New-ScheduledTaskTrigger { param([Parameter(ValueFromRemainingArguments)]$rest) [pscustomobject]@{} }
      function New-ScheduledTaskPrincipal { param([Parameter(ValueFromRemainingArguments)]$rest) [pscustomobject]@{} }
      function New-ScheduledTaskSettingsSet { param([Parameter(ValueFromRemainingArguments)]$rest) [pscustomobject]@{} }
      function Register-ScheduledTask { param($TaskName, $Action, $Trigger, $Principal, $Settings, [switch]$Force, [Parameter(ValueFromRemainingArguments)]$rest) $global:a = $Action; [pscustomobject]@{} }
      function Get-ScheduledTask { param($TaskName, [Parameter(ValueFromRemainingArguments)]$rest) [pscustomobject]@{ Actions = @($global:a) } }
      function Start-ScheduledTask { param($TaskName, [Parameter(ValueFromRemainingArguments)]$rest) }
      & '${registerScriptPath.replace(/'/g, "''")}' -StartNow
      exit $LASTEXITCODE
    `;
    const res = spawnSync(psHost, ['-NoProfile', '-Command', cmd], {
      cwd: tmp,
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: tmp, USERDOMAIN: 'TESTDOM', USERNAME: 'testuser' },
    });
    const combined = `${res.stdout || ''}\n${res.stderr || ''}`;
    assert.equal(res.status, 0, combined);
    assert.match(combined, /Registered/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
