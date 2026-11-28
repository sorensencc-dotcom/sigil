// Phase 7 setup Task 6: the entry point against real Windows protected storage.
// Runs only on Windows (the Windows CI jobs run it with npm test). Fake values
// and fixture IDs only. The database, registry, refresh check and `sigil bot add`
// child are fakes; every path, ACL, lock and file effect is real. The console
// hidden prompt cannot run without a console, so the Prompt helper action alone
// is replaced with a fixed answer, as in phase7-setup-storage.win.test.mjs.
//
// This is the leftover-file check: after a cancelled prompt with Ctrl-C, a
// completed run and a declined bot, the secret root holds no lock or temp file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { createSetupStorage, ROUTINE_FILE, LOCK_FILE, CHECKPOINT_FILE } from './phase7-setup-storage.mjs';
import { applyPhrase, botPhrase } from './phase7-setup-apply.mjs';
import { main, EXIT } from '../scripts/phase7-setup.mjs';

const skip = process.platform === 'win32' ? false : 'Windows only';
const DOMAIN = 'fixture.example';
const LABEL = 'TEST_DB';
const FAKE_URL = 'https://fixture.invalid/private-route?key=FAKE_QUERY';
const FAKE_KEY = 'FAKE_KEY_FOR_WINDOWS_ENTRY_TEST_ONLY';
const BOT = { botId: 'bot_test', endpointId: `ep_test_bot@${DOMAIN}`, displayName: 'Test Bot', role: 'reply', roleConfirmed: true };

// Real spawn for every helper action except the console-only Prompt, which
// answers with the next fixed value, or cancels when the value is null.
function promptStub(values, onPrompt = () => {}) {
  const prompts = [];
  const wrapped = (command, args, options) => {
    if (!args.includes('Prompt')) return spawn(command, args, options);
    prompts.push(args);
    onPrompt();
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const value = values.shift();
    const frame = value === null ? 'SIGIL-HELPER:ERR:PROMPT_CANCELLED' : `SIGIL-HELPER:SECRET:${Buffer.from(value).toString('base64')}`;
    Promise.all([new Promise((r) => child.stdout.on('end', r)), new Promise((r) => child.stderr.on('end', r))])
      .then(() => child.emit('close', 0));
    setImmediate(() => { child.stdout.end(`${frame}\r\n`); child.stderr.end(); });
    return child;
  };
  return { spawn: wrapped, prompts };
}

function config(root) {
  return {
    secretRoot: root,
    operatorIdentityPath: path.join(root, 'operator.identity.json'),
    registryPath: path.join(root, 'registry.json'),
    dbLabel: LABEL,
    databaseEnv: 'SIGIL_TEST_FAKE_DATABASE_ENV',
    wrapKeyRef: 'SIGIL_TEST_FAKE_WRAP_ENV',
    relayDomain: DOMAIN,
    routine: { urlEnv: 'SIGIL_TEST_UNSET_ROUTINE_URL', keyEnv: 'SIGIL_TEST_UNSET_ROUTINE_KEY' },
    bots: [{ ...BOT, identityPath: path.join(root, 'bot_test.identity.json') }],
  };
}

function deps({ home, root, stub, answers, botState }) {
  const signals = new EventEmitter();
  const out = [];
  const spawns = [];
  const fakeBotAdd = () => {
    spawns.push('bot add');
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => { botState.state = 'healthy'; child.stdout.end(); child.stderr.end(); child.emit('close', 0); });
    return child;
  };
  return {
    signals,
    out,
    spawns,
    deps: {
      out: (text) => out.push(text),
      home,
      platform: 'win32',
      env: { ...process.env, SIGIL_TEST_FAKE_DATABASE_ENV: 'postgres://fixture.invalid/TEST_DB', SIGIL_TEST_FAKE_WRAP_ENV: 'FAKE_WRAP_KEY_NOT_A_SECRET' },
      isTTY: true,
      repoRoot: realpathSync.native(process.cwd()),
      execPath: process.execPath,
      spawn: fakeBotAdd,
      signals,
      confirm: async () => (answers.length ? answers.shift() : null),
      readConfig: async () => config(root),
      createStorage: ({ mode }) => createSetupStorage({
        fs, spawn: stub.spawn, platform: 'win32', home, repoRoots: [realpathSync.native(process.cwd())],
        env: process.env, mode, ui: { write() {} },
      }),
      inspectDatabase: async () => ({ inspection: 'verified', schemaReady: true, bots: [{ ...BOT, state: botState.state }], blockers: [] }),
      preflightRegistry: async () => ({ ok: true, gaps: [] }),
      probeRegistryRefresh: async () => 'verified',
    },
  };
}

const leftovers = async (root) => (await fs.readdir(root)).filter((n) => n === LOCK_FILE || n.endsWith('.tmp'));

test('entry: no lock or temp file is left after Ctrl-C, a completed run or a declined bot', { skip }, async () => {
  const home = realpathSync.native(os.homedir());
  const base = path.join(home, `.sigil entry test ${randomBytes(4).toString('hex')}`);
  await fs.mkdir(base);
  try {
    const root = path.join(base, 'secrets');
    // First prepare creates and protects the root, then stops on the missing
    // operator identity; the identity and registry then inherit its ACL.
    const first = createSetupStorage({ fs, spawn, platform: 'win32', home, repoRoots: [realpathSync.native(process.cwd())], env: process.env, mode: 'apply', ui: { write() {} } });
    await assert.rejects(first.prepare(config(root)), (e) => e.code === 'STORAGE_PATH_REJECTED');
    await fs.writeFile(path.join(root, 'operator.identity.json'), '{}', { flag: 'wx' });
    await fs.writeFile(path.join(root, 'registry.json'), '{"endpoints":[]}', { flag: 'wx' });
    const botState = { state: 'missing' };

    // 1. Ctrl-C during the first hidden prompt: exit 3, lock released.
    let signals;
    const cancel = promptStub([null], () => signals.emit('SIGINT'));
    const a = deps({ home, root, stub: cancel, answers: [applyPhrase(LABEL)], botState });
    signals = a.signals;
    assert.equal(await main(['--apply'], a.deps), EXIT.DECLINED);
    assert.equal(cancel.prompts.length, 1);
    assert.deepEqual(a.spawns, []);
    assert.deepEqual(await leftovers(root), []);
    assert.equal((await fs.readdir(root)).includes(ROUTINE_FILE), false);
    assert.equal(a.signals.listenerCount('SIGINT'), 0);

    // 2. A completed run: routine inputs stored, the bot created, lock released.
    const ok = promptStub([FAKE_URL, FAKE_KEY]);
    const b = deps({ home, root, stub: ok, answers: [applyPhrase(LABEL), botPhrase(BOT.endpointId)], botState });
    assert.equal(await main(['--apply'], b.deps), EXIT.OK, b.out.join('\n'));
    assert.equal(ok.prompts.length, 2);
    assert.deepEqual(b.spawns, ['bot add']);
    assert.deepEqual(await leftovers(root), []);
    const names = await fs.readdir(root);
    assert.ok(names.includes(ROUTINE_FILE) && names.includes(CHECKPOINT_FILE));
    assert.doesNotMatch(b.out.join('\n'), /FAKE_KEY|FAKE_QUERY/);

    // 3. A declined bot: exit 4, nothing created, no prompt, lock released.
    botState.state = 'missing';
    const none = promptStub([]);
    const c = deps({ home, root, stub: none, answers: [applyPhrase(LABEL), 'no'], botState });
    assert.equal(await main(['--apply'], c.deps), EXIT.FAILED);
    assert.equal(none.prompts.length, 0);
    assert.deepEqual(c.spawns, []);
    assert.deepEqual(await leftovers(root), []);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
