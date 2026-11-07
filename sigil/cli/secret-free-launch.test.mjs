import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { cmdSecret } from './secret-command.mjs';
import { setMemoryCredentialStore, readCredential } from './credential-store.mjs';
import { loadWrapKey } from '../relay/v1/key-wrap.mjs';

function captureOutput(fn) {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;
  const origCode = process.exitCode;
  process.exitCode = 0;

  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));

  return Promise.resolve()
    .then(fn)
    .then(() => ({
      logs,
      errors,
      exitCode: process.exitCode ?? 0,
    }))
    .finally(() => {
      console.log = origLog;
      console.error = origError;
      process.exitCode = origCode;
    });
}

test('cmdSecret manages secrets in the store without exposing them in commands', async () => {
  const store = new Map();
  setMemoryCredentialStore(store);

  try {
    // Generate fresh wrap key
    const outSet = await captureOutput(() =>
      cmdSecret(['set', 'sigil/room-bot-wrap-key', '--generate-wrap-key'])
    );
    assert.equal(outSet.exitCode, 0);
    assert.ok(outSet.logs.some((l) => l.includes('Stored secret for target "sigil/room-bot-wrap-key"')));

    // Verify key in store is valid 32-byte base64
    const stored = readCredential('sigil/room-bot-wrap-key');
    assert.equal(Buffer.from(stored, 'base64').length, 32);

    // Get masked
    const outGetMasked = await captureOutput(() =>
      cmdSecret(['get', 'sigil/room-bot-wrap-key'])
    );
    assert.equal(outGetMasked.exitCode, 0);
    assert.ok(outGetMasked.logs.some((l) => l.includes('...')));
    assert.ok(!outGetMasked.logs.some((l) => l.includes(stored)));

    // Get show
    const outGetShow = await captureOutput(() =>
      cmdSecret(['get', 'sigil/room-bot-wrap-key', '--show'])
    );
    assert.equal(outGetShow.exitCode, 0);
    assert.ok(outGetShow.logs.includes(stored));

    // Delete
    const outDel = await captureOutput(() =>
      cmdSecret(['delete', 'sigil/room-bot-wrap-key'])
    );
    assert.equal(outDel.exitCode, 0);
    assert.ok(outDel.logs.some((l) => l.includes('Deleted secret')));
    assert.equal(store.has('sigil/room-bot-wrap-key'), false);
  } finally {
    setMemoryCredentialStore(null);
  }
});

test('secret-free launch: relay wrap key loads directly from credential store with no raw secret in argv or env', () => {
  const store = new Map();
  const testKey = crypto.randomBytes(32).toString('base64');
  store.set('sigil/room-bot-wrap-key', testKey);
  setMemoryCredentialStore(store);

  try {
    const cleanEnv = {}; // Process environment contains NO secret variables
    const flagArgv = ['--room-bot-key-wrap-key', 'cred:sigil/room-bot-wrap-key'];

    // Argv contains no secret bytes
    assert.ok(!flagArgv.some((arg) => arg.includes(testKey)));

    // The key resolves securely from the store reference
    const resolvedKey = loadWrapKey(flagArgv[1], cleanEnv);
    assert.equal(resolvedKey.length, 32);
    assert.equal(resolvedKey.toString('base64'), testKey);
  } finally {
    setMemoryCredentialStore(null);
  }
});
