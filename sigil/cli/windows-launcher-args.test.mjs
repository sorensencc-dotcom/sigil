import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const rootPath = fileURLToPath(root);
const scriptPath = fileURLToPath(new URL('scripts/windows/start-sigil-stack.ps1', root));
const registerScriptPath = fileURLToPath(new URL('scripts/windows/register-sigil-task.ps1', root));
const readmePath = fileURLToPath(new URL('scripts/windows/README.md', root));
const exampleConfigPath = fileURLToPath(new URL('docs/examples/service.example.json', root));

test('scripts/windows/README.md documents retirement and points to docs/service-config.md', () => {
  const readme = readFileSync(readmePath, 'utf8');
  assert.ok(readme.includes('RETIRED'));
  assert.ok(readme.includes('sigil service'));
  assert.ok(readme.includes('docs/service-config.md'));
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

test('start-sigil-stack.ps1 emits deprecation warning and runs WhatIf with dry-run flag', (t) => {
  if (!psHost) return t.skip('no PowerShell host available');
  const res = spawnSync(
    psHost,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ServiceConfig', exampleConfigPath, '-WhatIf'],
    { cwd: rootPath, encoding: 'utf8', env: process.env }
  );
  const combined = `${res.stdout || ''}\n${res.stderr || ''}`;
  assert.match(combined, /start-sigil-stack\.ps1 is deprecated/i);
  assert.match(combined, /sigil service start \[dry-run\]/i);
  assert.equal(res.status, 0);
});

test('register-sigil-task.ps1 emits deprecation warning and supports -WhatIf for install and unregister', (t) => {
  if (!psHost) return t.skip('no PowerShell host available');

  // Install WhatIf
  const resInstall = spawnSync(
    psHost,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', registerScriptPath, '-ServiceConfig', exampleConfigPath, '-WhatIf'],
    { cwd: rootPath, encoding: 'utf8', env: process.env }
  );
  const combinedInst = `${resInstall.stdout || ''}\n${resInstall.stderr || ''}`;
  assert.match(combinedInst, /register-sigil-task\.ps1 is deprecated/i);
  assert.match(combinedInst, /sigil service install \[dry-run\]/i);
  assert.equal(resInstall.status, 0);

  // Unregister WhatIf
  const resUnreg = spawnSync(
    psHost,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', registerScriptPath, '-ServiceConfig', exampleConfigPath, '-Unregister', '-WhatIf'],
    { cwd: rootPath, encoding: 'utf8', env: process.env }
  );
  const combinedUnreg = `${resUnreg.stdout || ''}\n${resUnreg.stderr || ''}`;
  assert.match(combinedUnreg, /register-sigil-task\.ps1 is deprecated/i);
  assert.match(combinedUnreg, /sigil service uninstall \[dry-run\]/i);
  assert.equal(resUnreg.status, 0);
});
