// Phase 7 setup Task 4: real Windows ACL proof on temporary directories.
// Runs only on Windows (the Windows CI jobs run it with npm test). Fake values
// only. The interactive hidden prompt cannot run without a console, so these
// tests swap in a fixed value for the Prompt action alone; every ACL, path and
// file effect below is real. The masked prompt and Ctrl-C stay for a hand check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSetupStorage, SetupStorageError, ROUTINE_FILE } from './phase7-setup-storage.mjs';

const isWindows = process.platform === 'win32';
const skip = isWindows ? false : 'Windows only';
const HELPER = fileURLToPath(new URL('./phase7-setup-windows.ps1', import.meta.url));
const WINDOWS_PS = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const BROAD_SIDS = ['S-1-1-0', 'S-1-5-32-545', 'S-1-5-11'];
const FAKE_URL = 'https://fixture.invalid/private-route?key=FAKE_QUERY';
const FAKE_KEY = 'FAKE_KEY_FOR_WINDOWS_ACL_TEST_ONLY';

// The runner's shell is PowerShell 7, whose PSModulePath breaks module loading
// in Windows PowerShell 5.1. Children get the environment without it, as the
// setup module does.
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  return env;
}

function shells() {
  const found = [WINDOWS_PS];
  const where = spawnSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true });
  const pwsh = where.status === 0 ? where.stdout.split(/\r?\n/).find(Boolean) : null;
  if (pwsh) found.push(pwsh.trim());
  return found;
}

// Independent read of an ACL, not through the module's helper.
function readAcl(target) {
  const script = [
    '$p = $env:SIGIL_TEST_TARGET',
    '$i = if ([System.IO.Directory]::Exists($p)) { [System.IO.DirectoryInfo]::new($p) } else { [System.IO.FileInfo]::new($p) }',
    '$acl = $i.GetAccessControl()',
    '$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ sid = $_.IdentityReference.Value; allow = ($_.AccessControlType -eq "Allow"); inherited = $_.IsInherited } }',
    '@{ owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; protected = $acl.AreAccessRulesProtected; me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules = @($rules) } | ConvertTo-Json -Depth 4 -Compress',
  ].join('; ');
  // -EncodedCommand avoids Windows PowerShell's quoting of -Command strings.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const res = spawnSync(WINDOWS_PS, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', windowsHide: true, env: childEnv({ SIGIL_TEST_TARGET: target }),
  });
  assert.equal(res.status, 0, `independent ACL read: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function assertTight(acl, { dir }) {
  const allowed = new Set([acl.me, 'S-1-5-18', 'S-1-5-32-544']);
  assert.ok([acl.me, 'S-1-5-32-544'].includes(acl.owner), 'owner is the current user or Administrators');
  if (dir) assert.equal(acl.protected, true, 'inheritance from the parent is disabled');
  assert.ok(acl.rules.length > 0);
  for (const rule of acl.rules) {
    assert.ok(allowed.has(rule.sid), `unexpected ACE ${rule.sid}`);
    assert.equal(BROAD_SIDS.includes(rule.sid), false);
  }
}

// Real spawn for every helper action except the console-only Prompt.
function promptStub(values) {
  const prompts = [];
  const wrapped = (command, args, options) => {
    if (!args.includes('Prompt')) return spawn(command, args, options);
    prompts.push({ args: [...args], stdio: options.stdio });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const value = values.shift();
    Promise.all([new Promise((r) => child.stdout.on('end', r)), new Promise((r) => child.stderr.on('end', r))])
      .then(() => child.emit('close', 0));
    setImmediate(() => { child.stdout.end(`SIGIL-HELPER:SECRET:${Buffer.from(value).toString('base64')}\r\n`); child.stderr.end(); });
    return child;
  };
  return { spawn: wrapped, prompts };
}

function setup() {
  const home = realpathSync.native(os.homedir());
  const base = path.join(home, `.sigil setup test ${randomBytes(4).toString('hex')}`);
  return { home, base };
}

function makeStorage({ home, spawnFn = spawn, powershellPath, mode = 'apply' }) {
  return createSetupStorage({
    fs, spawn: spawnFn, platform: 'win32', home, repoRoots: [realpathSync.native(process.cwd())],
    env: process.env, mode, ui: { write() {} }, powershellPath,
  });
}

function config(root) {
  return {
    secretRoot: root,
    operatorIdentityPath: path.join(root, 'operator.identity.json'),
    registryPath: path.join(root, 'registry.json'),
    dbLabel: 'TEST_DB', databaseEnv: 'SIGIL_TEST_DATABASE_URL', wrapKeyRef: 'cred:sigil-test-wrap',
    relayDomain: 'fixture.example',
    routine: { urlEnv: 'SIGIL_TEST_UNSET_ROUTINE_URL', keyEnv: 'SIGIL_TEST_UNSET_ROUTINE_KEY' },
    bots: [{ botId: 'bot_test', endpointId: 'ep_test_bot@fixture.example', displayName: 'Test Bot', role: 'reply', roleConfirmed: true, identityPath: path.join(root, 'bot_test.identity.json') }],
  };
}

async function rejectsCode(promise, code, reason) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof SetupStorageError, `expected SetupStorageError, got ${e?.name}`);
    assert.equal(e.code, code, `got ${e.code} (${e.detail ?? '-'}, ${e.reason ?? '-'})`);
    if (reason !== undefined) assert.equal(e.reason, reason);
    return true;
  });
}

test('protects a new root with spaces and Unicode for owner SYSTEM and Administrators only', { skip }, async () => {
  for (const shell of isWindows ? shells() : []) {
    const { home, base } = setup();
    await fs.mkdir(base);
    try {
      const root = path.join(base, 'secret root \u00e9\u2713');
      // First run creates and protects the root, then stops: no operator identity yet.
      await rejectsCode(makeStorage({ home, powershellPath: shell }).prepare(config(root)), 'STORAGE_PATH_REJECTED');
      assertTight(readAcl(root), { dir: true });
      await fs.writeFile(path.join(root, 'operator.identity.json'), '{}', { flag: 'wx' });
      await fs.writeFile(path.join(root, 'registry.json'), '{"endpoints":[]}', { flag: 'wx' });
      for (const name of ['operator.identity.json', 'registry.json']) assertTight(readAcl(path.join(root, name)), { dir: false });
      const storage = makeStorage({ home, powershellPath: shell });
      assert.deepEqual(await storage.prepare(config(root)), { secretRoot: 'protected' });
      await storage.close();
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }
});

test('writes routine credentials atomically with a verified ACL and never overwrites them', { skip }, async () => {
  const { home, base } = setup();
  await fs.mkdir(base);
  try {
    const root = path.join(base, 'secrets');
    await rejectsCode(makeStorage({ home }).prepare(config(root)), 'STORAGE_PATH_REJECTED');
    await fs.writeFile(path.join(root, 'operator.identity.json'), '{}', { flag: 'wx' });
    await fs.writeFile(path.join(root, 'registry.json'), '{}', { flag: 'wx' });

    const stub = promptStub([FAKE_URL, FAKE_KEY]);
    const storage = makeStorage({ home, spawnFn: stub.spawn });
    await storage.prepare(config(root));
    await storage.lock();
    const values = await storage.collectMissing(config(root));
    assert.deepEqual(await storage.persistRoutine(values), { written: true, fields: ['routine_url', 'sender_key'] });
    await storage.checkpoint({ phase: 'persisted' });
    await storage.close();
    assert.equal(stub.prompts.length, 2);
    for (const p of stub.prompts) assert.deepEqual([p.stdio[1], p.stdio[2]], ['pipe', 'pipe']);

    const file = path.join(root, ROUTINE_FILE);
    assertTight(readAcl(file), { dir: false });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1, url: FAKE_URL, key: FAKE_KEY });
    const names = (await fs.readdir(root)).sort();
    assert.deepEqual(names, [ROUTINE_FILE, 'operator.identity.json', 'phase7-setup-checkpoint.json', 'registry.json'].sort());

    // Rerun: nothing missing, so no prompt and the bytes stay the same.
    const before = await fs.readFile(file, 'utf8');
    const again = promptStub([]);
    const rerun = makeStorage({ home, spawnFn: again.spawn });
    await rerun.prepare(config(root));
    await rerun.lock();
    const none = await rerun.collectMissing(config(root));
    assert.deepEqual(await rerun.persistRoutine(none), { written: false, fields: [] });
    await rerun.close();
    assert.equal(again.prompts.length, 0);
    assert.equal(await fs.readFile(file, 'utf8'), before);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('refuses an existing loose directory and does not tighten it', { skip }, async () => {
  const { home, base } = setup();
  await fs.mkdir(base);
  try {
    const root = path.join(base, 'loose');
    await fs.mkdir(root);
    // Inheritance off (inherited entries copied), so the only problem left is
    // the broad entry and the helper must report it as broad-sid.
    const unlink = spawnSync('icacls.exe', [root, '/inheritance:d'], { encoding: 'utf8', windowsHide: true });
    assert.equal(unlink.status, 0, 'test setup turns inheritance off');
    const grant = spawnSync('icacls.exe', [root, '/grant', '*S-1-1-0:(OI)(CI)R'], { encoding: 'utf8', windowsHide: true });
    assert.equal(grant.status, 0, 'test setup grants Everyone read');
    await fs.writeFile(path.join(root, 'operator.identity.json'), '{}');
    await fs.writeFile(path.join(root, 'registry.json'), '{}');
    const stub = promptStub([FAKE_URL, FAKE_KEY]);
    const storage = makeStorage({ home, spawnFn: stub.spawn });
    await rejectsCode(storage.prepare(config(root)), 'STORAGE_ACL_FAILED', 'broad-sid');
    await rejectsCode(storage.collectMissing(config(root)), 'STORAGE_NOT_READY');
    assert.equal(stub.prompts.length, 0);
    assert.ok(readAcl(root).rules.some((r) => r.sid === 'S-1-1-0'), 'the loose ACL was left as it was');
    assert.deepEqual((await fs.readdir(root)).sort(), ['operator.identity.json', 'registry.json']);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('a directory made with mode 0700 alone is not accepted as protected', { skip }, async () => {
  const { home, base } = setup();
  await fs.mkdir(base);
  try {
    const root = path.join(base, 'posix-mode');
    await fs.mkdir(root, { mode: 0o700 });
    await fs.writeFile(path.join(root, 'operator.identity.json'), '{}', { mode: 0o600 });
    await fs.writeFile(path.join(root, 'registry.json'), '{}', { mode: 0o600 });
    await rejectsCode(makeStorage({ home }).prepare(config(root)), 'STORAGE_ACL_FAILED');
    assert.equal(readAcl(root).protected, false);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('rejects a junction anywhere on the path', { skip }, async () => {
  const { home, base } = setup();
  await fs.mkdir(base);
  try {
    const real = path.join(base, 'real');
    const junction = path.join(base, 'junction');
    await fs.mkdir(real);
    await fs.symlink(real, junction, 'junction');
    const calls = [];
    const counting = (command, args, options) => { calls.push(args); return spawn(command, args, options); };
    await rejectsCode(makeStorage({ home, spawnFn: counting }).prepare(config(path.join(junction, 'secrets'))), 'STORAGE_PATH_REJECTED');
    assert.deepEqual(calls, []);
    assert.deepEqual(await fs.readdir(real), []);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// Calls the helper directly so a failure names the helper's result code.
// Read-Host does not read a piped stdin under Windows PowerShell, so the prompt
// itself is not exercised here; it needs a real console and a hand check.
test('helper protects and verifies a fresh directory', { skip }, async () => {
  for (const shell of isWindows ? shells() : []) {
    const { base } = setup();
    await fs.mkdir(base);
    try {
      const dir = path.join(base, 'direct');
      await fs.mkdir(dir);
      const run = (...args) => {
        const res = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, ...args], {
          encoding: 'utf8', windowsHide: true, timeout: 60_000, env: childEnv(),
        });
        return { frames: (res.stdout ?? '').split(/\r?\n/).filter((l) => l.startsWith('SIGIL-HELPER:')), status: res.status, stderr: res.stderr };
      };
      const protect = run('-Action', 'ProtectDir', '-Path', dir);
      assert.deepEqual(protect.frames, ['SIGIL-HELPER:OK'], `${path.basename(shell)} ProtectDir: ${protect.stderr}`);
      const verify = run('-Action', 'VerifyAcl', '-Path', dir, '-Kind', 'Directory');
      assert.deepEqual(verify.frames, ['SIGIL-HELPER:OK'], `${path.basename(shell)} VerifyAcl: ${verify.stderr}`);
      assertTight(readAcl(dir), { dir: true });
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }
});
