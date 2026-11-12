// Phase 7 setup Task 4: storage boundary, proved with fake fs and fake spawn.
// Fixture IDs and fake values only. No real secret store, helper or database.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';
import {
  createSetupStorage,
  SetupStorageError,
  STORAGE_MESSAGES,
  ROUTINE_FILE,
  LOCK_FILE,
  CHECKPOINT_FILE,
  CHILD_ENV_ALLOWLIST,
  HELPER_REASONS,
} from './phase7-setup-storage.mjs';

const W = path.win32;
const HOME = 'C:\\Users\\fixture';
const ROOT = 'C:\\Users\\fixture\\.sigil-secrets';
const REPO = 'C:\\dev\\sigil';
const OPERATOR = `${ROOT}\\operator.identity.json`;
const REGISTRY = `${ROOT}\\registry.json`;

const SENTINEL_URL = 'https://fixture.invalid/private-route?key=FAKE_QUERY';
const SENTINEL_KEY_LONG = 'FAKE_KEY_LONG_0123456789abcdef0123456789abcdef';
const SENTINEL_KEY_SHORT = 'x';
const SENTINEL_DB = 'postgres://db.fixture.invalid/sigil_test?password=FAKE_DB_PASS';
const SENTINEL_BEARER = 'Bearer FAKE_BEARER_0123456789';

function config(overrides = {}) {
  return {
    secretRoot: ROOT,
    operatorIdentityPath: OPERATOR,
    registryPath: REGISTRY,
    dbLabel: 'TEST_DB',
    databaseEnv: 'SIGIL_TEST_DATABASE_URL',
    wrapKeyRef: 'cred:sigil-test-wrap',
    relayDomain: 'fixture.example',
    routine: { urlEnv: 'TEST_ROUTINE_URL', keyEnv: 'TEST_ROUTINE_KEY', keyHeader: 'Authorization: Bearer' },
    bots: [{
      botId: 'bot_test', endpointId: 'ep_test_bot@fixture.example', displayName: 'Test Bot',
      role: 'reply', roleConfirmed: true, identityPath: `${ROOT}\\bot_test.identity.json`,
    }],
    ...overrides,
  };
}

// In-memory win32 file system: case-insensitive, records every effect.
function createFakeFs({ dirs = [], files = {}, links = {}, fail = {} } = {}) {
  const nodes = new Map();
  const ops = [];
  const key = (p) => W.normalize(p).replace(/\\+$/, '').toLowerCase();
  const err = (code) => Object.assign(new Error(code), { code });
  const ensureDir = (p) => {
    const parts = W.normalize(p).split('\\');
    for (let i = 1; i <= parts.length; i += 1) {
      const sub = parts.slice(0, i).join('\\') || parts[0];
      const k = key(i === 1 ? `${sub}\\` : sub);
      if (!nodes.has(k)) nodes.set(k, { type: 'dir', path: i === 1 ? `${sub}` : sub });
    }
  };
  ensureDir(HOME);
  for (const d of dirs) ensureDir(d);
  for (const [p, data] of Object.entries(files)) { ensureDir(W.dirname(p)); nodes.set(key(p), { type: 'file', path: p, data }); }
  for (const [p, target] of Object.entries(links)) { ensureDir(W.dirname(p)); nodes.set(key(p), { type: 'link', path: p, target }); }
  const get = (p) => nodes.get(key(p));
  const parentDir = (p) => get(W.dirname(p));
  // A fail hook returns an error to throw for a given path, or nothing.
  const maybeFail = (op, p) => { const e = fail[op]?.(p); if (e) throw e; };
  const stat = (n) => ({
    isSymbolicLink: () => n.type === 'link',
    isDirectory: () => n.type === 'dir',
    isFile: () => n.type === 'file',
  });
  const api = {
    ops,
    nodes,
    read: (p) => get(p)?.data,
    exists: (p) => nodes.has(key(p)),
    list: (p) => [...nodes.values()].filter((n) => key(W.dirname(n.path)) === key(p) && key(n.path) !== key(p)).map((n) => W.basename(n.path)).sort(),
    async lstat(p) { maybeFail('lstat', p); const n = get(p); if (!n) throw err('ENOENT'); return stat(n); },
    async realpath(p) {
      const parts = W.normalize(p).split('\\');
      for (let i = 1; i <= parts.length; i += 1) {
        const sub = parts.slice(0, i).join('\\');
        const n = get(sub);
        if (n?.type === 'link') return W.join(n.target, ...parts.slice(i));
      }
      const n = get(p);
      if (!n) throw err('ENOENT');
      return n.path;
    },
    async mkdir(p) {
      ops.push(['mkdir', p]);
      if (get(p)) throw err('EEXIST');
      if (parentDir(p)?.type !== 'dir') throw err('ENOENT');
      nodes.set(key(p), { type: 'dir', path: p });
    },
    async open(p, flags) {
      ops.push(['open', p, flags]);
      maybeFail('open', p);
      if (flags !== 'wx') throw err('EINVAL');
      if (get(p)) throw err('EEXIST');
      if (parentDir(p)?.type !== 'dir') throw err('ENOENT');
      const node = { type: 'file', path: p, data: '' };
      nodes.set(key(p), node);
      return {
        async writeFile(data) { ops.push(['write', p]); maybeFail('writeFile', p); node.data = String(data); },
        async sync() {},
        async close() { ops.push(['close', p]); },
      };
    },
    async readFile(p) { maybeFail('readFile', p); const n = get(p); if (!n || n.type !== 'file') throw err('ENOENT'); return n.data; },
    async link(a, b) {
      ops.push(['link', a, b]);
      maybeFail('link', b);
      if (get(b)) throw err('EEXIST');
      const n = get(a);
      if (!n) throw err('ENOENT');
      nodes.set(key(b), { type: 'file', path: b, data: n.data });
    },
    async rename(a, b) {
      ops.push(['rename', a, b]);
      const n = get(a);
      if (!n) throw err('ENOENT');
      nodes.delete(key(a));
      nodes.set(key(b), { ...n, path: b });
    },
    async unlink(p) { ops.push(['unlink', p]); if (!nodes.delete(key(p))) throw err('ENOENT'); },
  };
  return api;
}

// Fake PowerShell helper. Records each spawn; answers per -Action.
function createFakeSpawn({ prompts = [], verify = () => 'OK', protect = 'OK', stderr = '' } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const action = args[args.indexOf('-Action') + 1];
    const target = args.includes('-Path') ? args[args.indexOf('-Path') + 1] : undefined;
    const kind = args.includes('-Kind') ? args[args.indexOf('-Kind') + 1] : 'Directory';
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = options.stdio[0] === 'pipe' ? new PassThrough() : null;
    child.kill = () => {};
    let out = '';
    let code = 0;
    if (action === 'Prompt') {
      const next = prompts.shift();
      if (next === undefined || next === null) { code = 1; out = 'noise without a frame\r\n'; }
      else out = `stray host text\r\nSIGIL-HELPER:SECRET:${Buffer.from(next, 'utf8').toString('base64')}\r\n`;
    } else if (action === 'ProtectDir') {
      out = `SIGIL-HELPER:${protect === 'OK' ? 'OK' : `ERR:${protect}`}\r\n`;
    } else if (action === 'VerifyAcl') {
      const result = verify(target, kind);
      out = `SIGIL-HELPER:${result === 'OK' ? 'OK' : `ERR:${result}`}\r\n`;
      if (result !== 'OK') code = 1;
    }
    Promise.all([
      new Promise((r) => child.stdout.on('end', r)),
      new Promise((r) => child.stderr.on('end', r)),
    ]).then(() => child.emit('close', code));
    setImmediate(() => { child.stdout.end(out); child.stderr.end(stderr); });
    return child;
  };
  return { spawn, calls };
}

function harness({ fsOpts = {}, spawnOpts = {}, mode = 'apply', platform = 'win32', env = {}, readCredential } = {}) {
  const fs = createFakeFs(fsOpts);
  const sp = createFakeSpawn(spawnOpts);
  const ui = [];
  const storage = createSetupStorage({
    fs,
    spawn: sp.spawn,
    platform,
    home: HOME,
    repoRoots: [REPO],
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32', ...env },
    readCredential,
    mode,
    ui: { write: (line) => ui.push(line) },
    now: () => '2026-11-12T00:00:00.000Z',
  });
  return { fs, sp, ui, storage };
}

const existingRoot = () => ({ dirs: [ROOT], files: { [OPERATOR]: '{}', [REGISTRY]: '{"endpoints":[]}' } });

async function rejectsCode(promise, code, reason) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof SetupStorageError, `expected SetupStorageError, got ${e?.name}`);
    assert.equal(e.code, code);
    if (reason !== undefined) assert.equal(e.reason, reason);
    return true;
  });
}

test('dry run does not create directories locks or prompts', async () => {
  const { fs, sp, ui, storage } = harness({ mode: 'dry-run' });
  const sources = await storage.inspectSources(config());
  assert.deepEqual(sources.routine, { urlState: 'missing', keyState: 'missing', keyHeader: 'valid' });
  assert.equal(sources.secretRoot, 'absent');
  await rejectsCode(storage.prepare(config()), 'DRY_RUN_NO_EFFECTS');
  await rejectsCode(storage.lock(), 'DRY_RUN_NO_EFFECTS');
  await rejectsCode(storage.collectMissing(config()), 'DRY_RUN_NO_EFFECTS');
  await rejectsCode(storage.persistRoutine({}), 'DRY_RUN_NO_EFFECTS');
  await rejectsCode(storage.checkpoint({ phase: 'prepared' }), 'DRY_RUN_NO_EFFECTS');
  await storage.close();
  assert.deepEqual(fs.ops, []);
  assert.deepEqual(sp.calls, []);
  assert.deepEqual(ui, []);
  for (const event of ['mkdir', 'acl-set', 'lock', 'prompt', 'write-secret', 'checkpoint']) {
    assert.equal(storage.events.includes(event), false, event);
  }
});

test('hidden prompt secrets travel over private stdin stdout pipes not argv', async () => {
  const { fs, sp, ui, storage } = harness({
    fsOpts: existingRoot(),
    spawnOpts: { prompts: [SENTINEL_URL, SENTINEL_KEY_LONG] },
    env: {
      [ 'SIGIL_TEST_DATABASE_URL' ]: SENTINEL_DB, OTHER_TOKEN_VAR: SENTINEL_BEARER,
      PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules',
    },
  });
  await storage.prepare(config());
  await storage.lock();
  const values = await storage.collectMissing(config());
  assert.deepEqual(values.names, ['routine_url', 'sender_key']);
  for (const shown of [JSON.stringify(values), String(values), inspect(values, { depth: 5, showHidden: true })]) {
    assert.equal(shown.includes(SENTINEL_KEY_LONG), false);
    assert.equal(shown.includes('FAKE_QUERY'), false);
  }
  const result = await storage.persistRoutine(values);
  assert.deepEqual(result, { written: true, fields: ['routine_url', 'sender_key'] });
  assert.deepEqual(JSON.parse(fs.read(`${ROOT}\\${ROUTINE_FILE}`)), { version: 1, url: SENTINEL_URL, key: SENTINEL_KEY_LONG });

  const prompts = sp.calls.filter((c) => c.args.includes('Prompt'));
  assert.equal(prompts.length, 2);
  for (const call of sp.calls) {
    assert.equal(W.isAbsolute(call.command), true, 'PowerShell is launched by absolute path');
    assert.equal(call.options.shell, false);
    assert.equal(call.args.includes('-Command'), false);
    assert.equal(W.isAbsolute(call.args[call.args.indexOf('-File') + 1]), true);
    assert.equal(call.options.stdio[1], 'pipe', 'stdout is a private pipe');
    assert.equal(call.options.stdio[2], 'pipe', 'stderr is a private pipe');
    const isPrompt = call.args.includes('Prompt');
    // Only the console's keystrokes reach the prompt helper; every other helper gets a pipe.
    assert.equal(call.options.stdio[0], isPrompt ? 'inherit' : 'pipe');
    for (const name of Object.keys(call.options.env)) assert.ok(CHILD_ENV_ALLOWLIST.includes(name), name);
    assert.equal('PSModulePath' in call.options.env, false, 'PowerShell 7 module path is not passed to Windows PowerShell');
  }
  const spawned = JSON.stringify(sp.calls);
  for (const value of [SENTINEL_URL, SENTINEL_KEY_LONG, SENTINEL_DB, SENTINEL_BEARER, 'FAKE_QUERY',
    Buffer.from(SENTINEL_KEY_LONG).toString('base64'), encodeURIComponent(SENTINEL_URL)]) {
    assert.equal(spawned.includes(value), false, 'no secret in argv or child env');
    assert.equal(ui.join('\n').includes(value), false, 'no secret in prompt labels');
  }
  assert.ok(storage.events.includes('prompt'));
  await storage.close();
});

test('rejects repo paths traversal reparse points and unsafe Windows names', async () => {
  const bad = [
    ['repo', `${REPO}\\secrets`],
    ['traversal', `${HOME}\\a\\..\\..\\evil`],
    ['relative', '.sigil-secrets'],
    ['unc', '\\\\server\\share\\secrets'],
    ['device', '\\\\?\\C:\\Users\\fixture\\secrets'],
    ['reserved', `${HOME}\\CON`],
    ['reserved-ext', `${HOME}\\nul.txt`],
    ['trailing-dot', `${HOME}\\secrets.`],
    ['trailing-space', `${HOME}\\secrets `],
    ['stream', `${HOME}\\secrets:hidden`],
    ['short-name', `${HOME}\\SECRE~1`],
    ['outside-home', 'C:\\Temp\\secrets'],
    ['reparse', `${HOME}\\linked\\secrets`],
    ['worktree', `${HOME}\\project\\secrets`],
  ];
  for (const [label, secretRoot] of bad) {
    const { fs, sp, storage } = harness({
      fsOpts: { dirs: [`${HOME}\\project\\.git`], links: { [`${HOME}\\linked`]: 'D:\\elsewhere' } },
    });
    await rejectsCode(storage.prepare(config({ secretRoot })), 'STORAGE_PATH_REJECTED');
    assert.equal((await storage.inspectSources(config({ secretRoot }))).secretRoot, 'rejected', label);
    assert.deepEqual(fs.ops, [], label);
    assert.deepEqual(sp.calls, [], label);
  }
  const inRepoBot = config();
  inRepoBot.bots = [{ ...inRepoBot.bots[0], identityPath: `${REPO}\\.sigil\\bot.json` }];
  const { fs, sp, storage } = harness({ fsOpts: existingRoot() });
  await rejectsCode(storage.prepare(inRepoBot), 'STORAGE_PATH_REJECTED');
  assert.equal(fs.ops.some(([op]) => op === 'mkdir' || op === 'open'), false);
  assert.equal(sp.calls.some((c) => c.args.includes('ProtectDir')), false);
});

test('ACL failure precedes every secret and DB write', async () => {
  const dbWrites = [];
  const guardedDbWrite = (storage) => { storage.assertReady(); dbWrites.push('bot add'); };

  // Existing loose directory: verified, never silently tightened.
  {
    const { fs, sp, storage } = harness({
      fsOpts: existingRoot(),
      spawnOpts: { prompts: [SENTINEL_URL, SENTINEL_KEY_LONG], verify: () => 'BROAD_SID' },
    });
    await rejectsCode(storage.prepare(config()), 'STORAGE_ACL_FAILED', 'broad-sid');
    assert.equal(sp.calls.some((c) => c.args.includes('ProtectDir')), false);
    await rejectsCode(storage.lock(), 'STORAGE_NOT_READY');
    await rejectsCode(storage.collectMissing(config()), 'STORAGE_NOT_READY');
    await rejectsCode(storage.persistRoutine({}), 'STORAGE_NOT_READY');
    await rejectsCode(storage.checkpoint({ phase: 'failed' }), 'STORAGE_NOT_READY');
    assert.throws(() => guardedDbWrite(storage), (e) => e.code === 'STORAGE_NOT_READY');
    assert.equal(storage.events.includes('prompt'), false);
    assert.equal(storage.events.includes('write-secret'), false);
    assert.equal(fs.ops.some(([op]) => ['open', 'link', 'rename'].includes(op)), false);
  }
  // New directory whose ACL does not verify after being set.
  {
    const { fs, storage } = harness({ fsOpts: { files: {} }, spawnOpts: { verify: () => 'INHERITANCE_ENABLED' } });
    await rejectsCode(storage.prepare(config()), 'STORAGE_ACL_FAILED', 'inheritance-enabled');
    assert.equal(storage.events.includes('write-secret'), false);
    assert.equal(fs.ops.some(([op]) => op === 'open'), false);
  }
  // An existing registry with a loose ACL also blocks.
  {
    const { storage } = harness({ fsOpts: existingRoot(), spawnOpts: { verify: (p) => (p === REGISTRY ? 'BROAD_SID' : 'OK') } });
    await rejectsCode(storage.prepare(config()), 'STORAGE_ACL_FAILED');
    assert.throws(() => guardedDbWrite(storage), (e) => e.code === 'STORAGE_NOT_READY');
  }
  // POSIX mode 0600 alone is not accepted as protection.
  {
    const { fs, sp, storage } = harness({ platform: 'linux', fsOpts: existingRoot() });
    await rejectsCode(storage.prepare(config()), 'STORAGE_ACL_UNSUPPORTED');
    assert.deepEqual(fs.ops, []);
    assert.deepEqual(sp.calls, []);
  }
  // The written file is verified too; a failed check removes it.
  {
    const file = `${ROOT}\\${ROUTINE_FILE}`;
    const { fs, storage } = harness({
      fsOpts: existingRoot(),
      spawnOpts: { prompts: [SENTINEL_URL, SENTINEL_KEY_LONG], verify: (p) => (p === file ? 'BROAD_SID' : 'OK') },
    });
    await storage.prepare(config());
    await storage.lock();
    const values = await storage.collectMissing(config());
    await rejectsCode(storage.persistRoutine(values), 'STORAGE_ACL_FAILED');
    assert.equal(fs.exists(file), false);
    await storage.close();
  }
  assert.deepEqual(dbWrites, []);
});

test('existing credential is never overwritten', async () => {
  const file = `${ROOT}\\${ROUTINE_FILE}`;
  const stored = JSON.stringify({ version: 1, url: 'https://fixture.invalid/old', key: 'OLD_FIXTURE_KEY' });
  // A complete stored file is present: no prompt, nothing to write.
  {
    const { fs, sp, storage } = harness({ fsOpts: { dirs: [ROOT], files: { [OPERATOR]: '{}', [REGISTRY]: '{}', [file]: stored } } });
    assert.deepEqual((await storage.inspectSources(config())).routine, { urlState: 'present', keyState: 'present', keyHeader: 'valid' });
    await storage.prepare(config());
    await storage.lock();
    const values = await storage.collectMissing(config());
    assert.deepEqual(values.names, []);
    assert.equal(sp.calls.some((c) => c.args.includes('Prompt')), false);
    assert.deepEqual(await storage.persistRoutine(values), { written: false, fields: [] });
    assert.equal(fs.read(file), stored);
    await storage.close();
  }
  // A partial stored file needs review; it is never topped up in place.
  {
    const partial = JSON.stringify({ version: 1, url: 'https://fixture.invalid/old' });
    const { fs, sp, storage } = harness({ fsOpts: { dirs: [ROOT], files: { [OPERATOR]: '{}', [REGISTRY]: '{}', [file]: partial } } });
    assert.equal((await storage.inspectSources(config())).routine.keyState, 'needs-review');
    await storage.prepare(config());
    await storage.lock();
    await rejectsCode(storage.collectMissing(config()), 'ROUTINE_NEEDS_REVIEW');
    assert.equal(sp.calls.some((c) => c.args.includes('Prompt')), false);
    assert.equal(fs.read(file), partial);
    await storage.close();
  }
  // A file that appears between inspection and the write wins; the new values are dropped.
  {
    const { fs, storage } = harness({ fsOpts: existingRoot(), spawnOpts: { prompts: [SENTINEL_URL, SENTINEL_KEY_LONG] } });
    await storage.prepare(config());
    await storage.lock();
    const values = await storage.collectMissing(config());
    fs.nodes.set(file.toLowerCase(), { type: 'file', path: file, data: stored });
    await rejectsCode(storage.persistRoutine(values), 'CREDENTIAL_EXISTS');
    assert.equal(fs.read(file), stored);
    assert.deepEqual(fs.list(ROOT).filter((n) => n.endsWith('.tmp')), []);
    await storage.close();
  }
});

test('atomic secret write leaves no public temp or backup', async () => {
  {
    const { fs, storage } = harness({ fsOpts: existingRoot(), spawnOpts: { prompts: [SENTINEL_URL, SENTINEL_KEY_LONG] } });
    await storage.prepare(config());
    await storage.lock();
    await storage.persistRoutine(await storage.collectMissing(config()));
    const opened = fs.ops.filter(([op]) => op === 'open').map(([, p, flags]) => [W.dirname(p).toLowerCase(), flags]);
    for (const [dir, flags] of opened) {
      assert.equal(dir, ROOT.toLowerCase(), 'temp files live only inside the protected root');
      assert.equal(flags, 'wx');
    }
    assert.ok(fs.ops.some(([op, , to]) => op === 'link' && to === `${ROOT}\\${ROUTINE_FILE}`), 'no-clobber link');
    await storage.close();
    assert.deepEqual(fs.list(ROOT), [ROUTINE_FILE, 'operator.identity.json', 'registry.json'].sort());
  }
  {
    const fail = { writeFile: (p) => (p.includes(ROUTINE_FILE) ? Object.assign(new Error(`disk full ${SENTINEL_URL}`), { code: 'ENOSPC' }) : undefined) };
    const { fs, storage } = harness({ fsOpts: { ...existingRoot(), fail }, spawnOpts: { prompts: [SENTINEL_URL, SENTINEL_KEY_LONG] } });
    await storage.prepare(config());
    await storage.lock();
    const values = await storage.collectMissing(config());
    await rejectsCode(storage.persistRoutine(values), 'STORAGE_WRITE_FAILED');
    assert.equal(fs.exists(`${ROOT}\\${ROUTINE_FILE}`), false);
    assert.deepEqual(fs.list(ROOT), [LOCK_FILE, 'operator.identity.json', 'registry.json'].sort());
    await storage.close();
    assert.equal(fs.list(ROOT).some((n) => /\.(tmp|bak|old)$|~$/i.test(n)), false);
  }
});

test('checkpoint is allowlisted', async () => {
  const { fs, storage } = harness({ fsOpts: existingRoot() });
  await storage.prepare(config());
  await storage.lock();
  await storage.checkpoint({ phase: 'provisioning', created: ['bot_test'], skipped: ['bot_test_other'], blockers: [], registryRefresh: 'verified' });
  const written = JSON.parse(fs.read(`${ROOT}\\${CHECKPOINT_FILE}`));
  assert.deepEqual(written, {
    version: 1, mode: 'apply', phase: 'provisioning', created: ['bot_test'], skipped: ['bot_test_other'],
    failed: [], blockers: [], registryRefresh: 'verified', at: '2026-11-12T00:00:00.000Z',
  });
  const before = fs.read(`${ROOT}\\${CHECKPOINT_FILE}`);
  await rejectsCode(storage.checkpoint({ phase: 'failed', routineUrl: SENTINEL_URL }), 'INVALID_CHECKPOINT');
  await rejectsCode(storage.checkpoint({ phase: 'failed', created: [SENTINEL_URL] }), 'INVALID_CHECKPOINT');
  await rejectsCode(storage.checkpoint({ phase: 'failed', blockers: [`db ${SENTINEL_DB}`] }), 'INVALID_CHECKPOINT');
  await rejectsCode(storage.checkpoint({ phase: 'whatever' }), 'INVALID_CHECKPOINT');
  assert.equal(fs.read(`${ROOT}\\${CHECKPOINT_FILE}`), before);
  assert.equal(fs.list(ROOT).some((n) => n.endsWith('.tmp')), false);
  await storage.close();
});

test('short encoded and exception secrets never enter logs', async () => {
  const forbidden = [
    SENTINEL_URL, SENTINEL_KEY_LONG, SENTINEL_DB, SENTINEL_BEARER,
    'private-route', 'FAKE_QUERY', 'FAKE_DB_PASS', 'FAKE_BEARER', 'fixture.invalid',
    encodeURIComponent(SENTINEL_URL), encodeURI(SENTINEL_URL),
    Buffer.from(SENTINEL_URL).toString('base64'), Buffer.from(SENTINEL_KEY_LONG).toString('base64'),
    Buffer.from(SENTINEL_KEY_SHORT).toString('base64'),
  ];
  const everything = `${SENTINEL_URL} ${SENTINEL_KEY_LONG} ${SENTINEL_KEY_SHORT} ${SENTINEL_DB} ${SENTINEL_BEARER}`;
  const allowedMessages = new Set(Object.values(STORAGE_MESSAGES));
  const surfaces = [];
  const capture = async (promise) => {
    try { surfaces.push(['value', await promise]); } catch (e) {
      assert.ok(e instanceof SetupStorageError);
      assert.ok(allowedMessages.has(e.message), 'fixed message only');
      assert.equal(e.cause, undefined);
      for (const own of Object.keys(e)) assert.ok(['code', 'detail', 'reason'].includes(own), own);
      if (e.detail !== undefined) assert.match(e.detail, /^[a-z0-9-]{1,40}$/);
      if (e.reason !== undefined) assert.ok(HELPER_REASONS.includes(e.reason), 'fixed helper reason only');
      surfaces.push(['error', e.message, e.stack, String(e), JSON.stringify(e), inspect(e, { depth: 5, showHidden: true })]);
    }
  };

  // 1. An fs exception carrying every sentinel.
  {
    const fail = { writeFile: (p) => (p.includes(ROUTINE_FILE) ? Object.assign(new Error(everything), { code: 'EIO', path: SENTINEL_DB }) : undefined) };
    const { storage } = harness({ fsOpts: { ...existingRoot(), fail }, spawnOpts: { prompts: [SENTINEL_URL, SENTINEL_KEY_SHORT] } });
    await storage.prepare(config());
    await storage.lock();
    await capture(storage.persistRoutine(await storage.collectMissing(config())));
    surfaces.push(['events', storage.events]);
    await storage.close();
  }
  // 2. Helper stderr and a garbage error frame carrying every sentinel.
  {
    const { ui, storage } = harness({ fsOpts: existingRoot(), spawnOpts: { stderr: everything, verify: () => `X ${everything}` } });
    await capture(storage.prepare(config()));
    surfaces.push(['ui', ui]);
  }
  // 3. Prompted values that fail validation (http, CR/LF in key).
  {
    const { ui, storage } = harness({ fsOpts: existingRoot(), spawnOpts: { prompts: [SENTINEL_URL.replace('https', 'http')] } });
    await storage.prepare(config());
    await storage.lock();
    await capture(storage.collectMissing(config()));
    surfaces.push(['ui', ui]);
    await storage.close();
  }
  {
    const { storage } = harness({ fsOpts: existingRoot(), spawnOpts: { prompts: [SENTINEL_URL, `${SENTINEL_KEY_SHORT}\r\n${SENTINEL_BEARER}`] } });
    await storage.prepare(config());
    await storage.lock();
    await capture(storage.collectMissing(config()));
    await storage.close();
  }
  // 4. Invalid values from env, and a credential store that throws with every sentinel.
  {
    const readCredential = () => { throw Object.assign(new Error(everything), { code: 'CREDENTIAL_STORE_ERROR' }); };
    const routine = { urlEnv: 'TEST_ROUTINE_URL', keyRef: 'cred:sigil-test-routine-key' };
    const { storage } = harness({ fsOpts: existingRoot(), env: { TEST_ROUTINE_URL: `${SENTINEL_URL}#frag` }, readCredential });
    const sources = await storage.inspectSources(config({ routine }));
    assert.deepEqual(sources.routine, { urlState: 'invalid', keyState: 'unavailable', keyHeader: 'valid' });
    surfaces.push(['sources', sources]);
    await storage.prepare(config({ routine }));
    await storage.lock();
    await capture(storage.collectMissing(config({ routine })));
    surfaces.push(['events', storage.events]);
    await storage.close();
  }
  // 5. A short key round-trips without appearing anywhere public.
  {
    const { fs, ui, storage } = harness({ fsOpts: existingRoot(), spawnOpts: { prompts: [SENTINEL_URL, SENTINEL_KEY_SHORT] } });
    await storage.prepare(config());
    await storage.lock();
    const values = await storage.collectMissing(config());
    const result = await storage.persistRoutine(values);
    assert.deepEqual(result, { written: true, fields: ['routine_url', 'sender_key'] });
    assert.equal(JSON.parse(fs.read(`${ROOT}\\${ROUTINE_FILE}`)).key, SENTINEL_KEY_SHORT);
    assert.deepEqual(storage.events, ['acl-verify', 'acl-verify', 'acl-verify', 'lock', 'inspect', 'prompt', 'prompt', 'write-secret', 'acl-verify']);
    assert.deepEqual(ui, ['Routine webhook URL (input hidden): ', 'Routine sender key (input hidden): ']);
    assert.equal(JSON.stringify(values), '"[private]"');
    await storage.close();
  }

  assert.ok(surfaces.filter(([kind]) => kind === 'error').length >= 5);
  const text = JSON.stringify(surfaces);
  for (const value of forbidden) assert.equal(text.includes(value), false, `leaked ${value.slice(0, 12)}`);
});
