import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isCredentialRef,
  parseCredentialRef,
  readCredential,
  writeCredential,
  deleteCredential,
  setMemoryCredentialStore,
  getLinuxKeystorePath,
  readLinuxFileKeystore,
  writeLinuxFileKeystore,
  deleteLinuxFileKeystore,
} from './credential-store.mjs';

test('isCredentialRef and parseCredentialRef recognize cred: and credential: URIs', () => {
  assert.equal(isCredentialRef('cred:sigil/wrap-key'), true);
  assert.equal(isCredentialRef('credential:sigil/wrap-key'), true);
  assert.equal(isCredentialRef('SIGIL_ROOM_BOT_KEY_WRAP_KEY'), false);
  assert.equal(isCredentialRef(null), false);
  assert.equal(isCredentialRef(undefined), false);

  assert.equal(parseCredentialRef('cred:sigil/wrap-key'), 'sigil/wrap-key');
  assert.equal(parseCredentialRef('credential:sigil/wrap-key'), 'sigil/wrap-key');
  assert.equal(parseCredentialRef('SIGIL_WRAP'), 'SIGIL_WRAP');
});

test('memory store supports read, write, and delete operations', () => {
  const store = new Map();
  setMemoryCredentialStore(store);
  try {
    assert.throws(() => readCredential('target1'), { code: 'CREDENTIAL_NOT_FOUND' });

    writeCredential('target1', 'secret-val-123');
    assert.equal(readCredential('target1'), 'secret-val-123');

    deleteCredential('target1');
    assert.throws(() => readCredential('target1'), { code: 'CREDENTIAL_NOT_FOUND' });
  } finally {
    setMemoryCredentialStore(null);
  }
});

test('Windows platform execution invokes powershell helper with correct arguments and handles missing key', () => {
  const calls = [];
  const mockExec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args.includes('Read') && args.includes('missing-target')) {
      return { status: 2, stdout: '', stderr: 'CREDENTIAL_NOT_FOUND' };
    }
    if (args.includes('Read')) {
      return { status: 0, stdout: 'recovered-secret', stderr: '' };
    }
    if (args.includes('Write')) {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args.includes('Delete')) {
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'error' };
  };

  assert.throws(
    () => readCredential('missing-target', { platform: 'win32', execFn: mockExec }),
    { code: 'CREDENTIAL_NOT_FOUND' }
  );

  const val = readCredential('existing-target', { platform: 'win32', execFn: mockExec });
  assert.equal(val, 'recovered-secret');

  writeCredential('save-target', 'my-secret', { platform: 'win32', execFn: mockExec });
  const writeCall = calls.find((c) => c.args.includes('Write'));
  assert.ok(writeCall);
  assert.equal(writeCall.opts.input, 'my-secret', 'secret must be passed through stdin, never argv');

  deleteCredential('del-target', { platform: 'win32', execFn: mockExec });
  const delCall = calls.find((c) => c.args.includes('Delete'));
  assert.ok(delCall);
});

test('macOS and Linux adapters execute platform utilities with expected arguments', () => {
  const calls = [];
  const mockExec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: 'mock-platform-secret\n', stderr: '' };
  };

  const macVal = readCredential('mac-target', { platform: 'darwin', execFn: mockExec });
  assert.equal(macVal, 'mock-platform-secret');

  const linuxVal = readCredential('linux-target', { platform: 'linux', execFn: mockExec });
  assert.equal(linuxVal, 'mock-platform-secret');
});

test('Linux credential adapter falls back to file keystore when secret-tool fails or is missing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-cred-file-'));
  const keystorePath = path.join(tempDir, 'credentials.json');

  try {
    // Mock execFn simulating secret-tool not found or failing
    const mockFailingExec = () => ({
      status: 1,
      stdout: '',
      stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY',
      error: { code: 'ENOENT' },
    });

    // Write should fall back to file keystore
    writeCredential('room-bot-key', 'secret-wrap-xyz', {
      platform: 'linux',
      execFn: mockFailingExec,
      keystorePath,
    });

    // File should exist and contain the secret
    assert.ok(fs.existsSync(keystorePath));
    const content = JSON.parse(fs.readFileSync(keystorePath, 'utf8'));
    assert.equal(content['room-bot-key'], 'secret-wrap-xyz');

    // Read should fall back to file keystore
    const readVal = readCredential('room-bot-key', {
      platform: 'linux',
      execFn: mockFailingExec,
      keystorePath,
    });
    assert.equal(readVal, 'secret-wrap-xyz');

    // Missing key should throw CREDENTIAL_NOT_FOUND
    assert.throws(
      () => readCredential('nonexistent-key', {
        platform: 'linux',
        execFn: mockFailingExec,
        keystorePath,
      }),
      { code: 'CREDENTIAL_NOT_FOUND' }
    );

    // Delete should clean up entry from file keystore
    deleteCredential('room-bot-key', {
      platform: 'linux',
      execFn: mockFailingExec,
      keystorePath,
    });
    assert.throws(
      () => readCredential('room-bot-key', {
        platform: 'linux',
        execFn: mockFailingExec,
        keystorePath,
      }),
      { code: 'CREDENTIAL_NOT_FOUND' }
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

