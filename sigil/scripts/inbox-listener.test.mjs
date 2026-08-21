import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const listener = fileURLToPath(new URL('./inbox-listener.mjs', import.meta.url));

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-inbox-listener-test-'));
}

function runListener(root, command, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [listener, command, '--root', root, '--state-dir', path.join(root, 'state'), ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
function exitedChildPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '']);
    child.on('error', reject);
    child.on('close', () => resolve(child.pid));
  });
}


async function safeRemove(dirPath) {
  for (let i = 0; i < 30; i++) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

test('read exits cleanly when inbox log is absent', async () => {
  const root = temporaryRoot();
  try {
    const result = await runListener(root, 'read');

    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(path.join(root, 'state', 'inbox-listener.offset')), false);
  } finally {
    await safeRemove(root);
  }
});

test('read emits lines after stored offset and advances offset to log length', async () => {
  const root = temporaryRoot();
  const state = path.join(root, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'inbox-listener.log'), 'old\nnew one\nnew two\n', 'utf8');
  fs.writeFileSync(path.join(state, 'inbox-listener.offset'), '1\n', 'utf8');

  try {
    const result = await runListener(root, 'read');

    assert.equal(result.code, 0);
    assert.equal(result.stdout.replace(/\r\n/g, '\n'), 'new one\nnew two\n');
    assert.equal(fs.readFileSync(path.join(state, 'inbox-listener.offset'), 'utf8').trim(), '3');
  } finally {
    await safeRemove(root);
  }
});

test('start is a no-op when pid file points to a live process', async () => {
  const root = temporaryRoot();
  const state = path.join(root, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'inbox-listener.pid'), `${process.pid}\n`, 'utf8');

  try {
    const result = await runListener(root, 'start');

    assert.equal(result.code, 0);
    assert.equal(fs.readFileSync(path.join(state, 'inbox-listener.pid'), 'utf8').trim(), String(process.pid));
    assert.equal(fs.existsSync(path.join(state, 'inbox-listener.log')), false);
  } finally {
    await safeRemove(root);
  }
});

test('start replaces stale pid with a detached listener process', async () => {
  const root = temporaryRoot();
  const state = path.join(root, 'state');
  const cli = path.join(root, 'sigil', 'cli');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(cli, { recursive: true });
  const stalePid = await exitedChildPid();
  fs.writeFileSync(path.join(state, 'inbox-listener.pid'), `${stalePid}\n`, 'utf8');
  fs.writeFileSync(path.join(cli, 'sigil.mjs'), 'setTimeout(() => process.exit(0), 10000);\n', 'utf8');

  let childPid;
  try {
    const result = await runListener(root, 'start', ['--identity', 'test-identity', '--relay-url', 'http://relay.test', '--stream-url', 'ws://stream.test']);

    assert.equal(result.code, 0);
    childPid = Number(fs.readFileSync(path.join(state, 'inbox-listener.pid'), 'utf8').trim());
    assert.notEqual(childPid, stalePid);
    assert.ok(childPid > 0);
    assert.doesNotThrow(() => process.kill(childPid, 0));
  } finally {
    if (childPid) {
      try {
        if (process.platform === 'win32') {
          try {
            const { execSync } = await import('node:child_process');
            execSync(`taskkill /F /T /PID ${childPid}`, { stdio: 'ignore' });
          } catch {}
          try { process.kill(childPid, 'SIGKILL'); } catch {}
        } else {
          process.kill(childPid, 'SIGKILL');
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await safeRemove(root);
  }
});
