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


const hexOf = (text) => Buffer.from(text, 'utf8').toString('hex');

test('writeCredential never puts the secret in a child process argument list (#330)', () => {
  const secret = 'top-secret "quoted" \\ value';
  for (const platform of ['win32', 'darwin', 'linux']) {
    const calls = [];
    const mockExec = (cmd, args, opts = {}) => {
      calls.push({ cmd, args, opts });
      if (args.includes('find-generic-password')) {
        return { status: 0, stdout: `${secret}\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    writeCredential('argv-target', secret, { platform, execFn: mockExec });
    assert.ok(calls.length > 0, `${platform} ran no command`);
    for (const call of calls) {
      const argv = call.args.join(' ');
      assert.ok(!argv.includes('top-secret'), `${platform}: secret found in argv of ${call.cmd}`);
      assert.ok(!argv.includes(hexOf(secret)), `${platform}: hex secret found in argv of ${call.cmd}`);
    }
    const expected = platform === 'darwin' ? hexOf(secret) : 'top-secret';
    assert.ok(
      calls.some((c) => typeof c.opts.input === 'string' && c.opts.input.includes(expected)),
      `${platform}: secret not passed on stdin`
    );
  }
});

test('macOS write drives security -i on stdin with quoted names and a hex secret, then reads it back', () => {
  const calls = [];
  const mockExec = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    if (args.includes('find-generic-password')) return { status: 0, stdout: 'a"b\\c\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  writeCredential('mac "target"', 'a"b\\c', { platform: 'darwin', execFn: mockExec });
  assert.equal(calls[0].cmd, 'security');
  assert.deepEqual(calls[0].args, ['-i']);
  assert.equal(
    calls[0].opts.input,
    `add-generic-password -U -s "mac \\"target\\"" -a "${process.env.USER || 'sigil'}" -X ${hexOf('a"b\\c')}\n`
  );
  assert.ok(calls[1].args.includes('find-generic-password'));
});

test('macOS write stores a multiline secret and accepts a hex read-back', () => {
  const pem = '-----BEGIN KEY-----\nabc\n-----END KEY-----';
  const calls = [];
  const mockExec = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    if (args.includes('find-generic-password')) return { status: 0, stdout: `${hexOf(pem)}\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  writeCredential('pem-target', pem, { platform: 'darwin', execFn: mockExec });
  assert.equal(calls[0].opts.input.split('\n').length, 2, 'command must stay on one line');
});

test('macOS write is unconfirmed when the item does not read back, even if security -i exits 0', () => {
  const mockExec = (cmd, args) =>
    args.includes('find-generic-password')
      ? { status: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' }
      : { status: 0, stdout: '', stderr: '' };
  assert.throws(() => writeCredential('mac-target', 'value', { platform: 'darwin', execFn: mockExec }), {
    code: 'CREDENTIAL_STORE_UNCONFIRMED',
    message: /may or may not be saved/,
  });
});

test('macOS write is unconfirmed when the read-back returns a different value', () => {
  const mockExec = (cmd, args) =>
    args.includes('find-generic-password')
      ? { status: 0, stdout: 'some-older-value\n', stderr: '' }
      : { status: 0, stdout: '', stderr: '' };
  assert.throws(() => writeCredential('mac-target', 'value', { platform: 'darwin', execFn: mockExec }), {
    code: 'CREDENTIAL_STORE_UNCONFIRMED',
  });
});

test('macOS write fails cleanly when security -i itself fails', () => {
  const mockExec = () => ({ status: 1, stdout: '', stderr: 'security: SecKeychainSearchCopyNext failed' });
  assert.throws(() => writeCredential('mac-target', 'value', { platform: 'darwin', execFn: mockExec }), {
    code: 'CREDENTIAL_STORE_ERROR',
  });
});

test('macOS write refuses a service name with a line break before running anything', () => {
  let ran = false;
  const mockExec = () => {
    ran = true;
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.throws(() => writeCredential('bad\ntarget', 'value', { platform: 'darwin', execFn: mockExec }), {
    code: 'CREDENTIAL_NAME_INVALID',
  });
  assert.equal(ran, false);
});
