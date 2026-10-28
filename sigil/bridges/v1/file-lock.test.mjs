import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireLock,
  breakLockFile,
  readLockDiagnostics,
  renameWithRetry,
  withLock,
} from './file-lock.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-file-lock-'));
}

function fakeClock(startMs = Date.parse('2026-10-28T12:00:00.000Z')) {
  let nowMs = startMs;
  return {
    now: () => new Date(nowMs),
    advance(ms) { nowMs += ms; },
    get ms() { return nowMs; },
  };
}

test('acquire creates lock file and release removes it', async () => {
  const dir = tempDir();
  const lockPath = path.join(dir, 'bot.lock');
  const clock = fakeClock();
  const handle = await acquireLock(lockPath, { waitMs: 0, now: clock.now, host: 'testhost' });
  const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(raw.host, 'testhost');
  assert.equal(raw.pid, process.pid);
  assert.equal(typeof raw.token, 'string');
  assert.equal(raw.acquired_at, clock.now().toISOString());
  handle.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test('second acquire waits then throws LOCK_TIMEOUT without stealing', async () => {
  const dir = tempDir();
  const lockPath = path.join(dir, 'bot.lock');
  const clock = fakeClock();
  const sleeps = [];
  const first = await acquireLock(lockPath, { waitMs: 0, now: clock.now, host: 'h1' });
  const before = fs.readFileSync(lockPath);
  await assert.rejects(
    () => acquireLock(lockPath, {
      waitMs: 100,
      pollMs: 40,
      now: clock.now,
      sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setTimeout(r, ms)); },
      host: 'h2',
    }),
    (error) => error.code === 'LOCK_TIMEOUT'
      && error.lockPath === lockPath
      && error.diagnostics?.host === 'h1'
      && error.diagnostics?.pid === process.pid,
  );
  assert.ok(sleeps.length >= 1);
  assert.deepEqual(fs.readFileSync(lockPath), before);
  first.release();
});

test('readLockDiagnostics and breakLockFile', async () => {
  const dir = tempDir();
  const lockPath = path.join(dir, 'bot.lock');
  assert.equal(readLockDiagnostics(lockPath), null);
  const handle = await acquireLock(lockPath, { waitMs: 0, host: 'break-host' });
  const diag = readLockDiagnostics(lockPath);
  assert.equal(diag.host, 'break-host');
  assert.equal(diag.token, handle.token);
  const broken = breakLockFile(lockPath);
  assert.equal(broken.token, handle.token);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(breakLockFile(lockPath), null);
});

test('release removes only when token still matches', async () => {
  const dir = tempDir();
  const lockPath = path.join(dir, 'bot.lock');
  const first = await acquireLock(lockPath, { waitMs: 0, host: 'old' });
  breakLockFile(lockPath);
  const second = await acquireLock(lockPath, { waitMs: 0, host: 'new' });
  first.release();
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(readLockDiagnostics(lockPath).host, 'new');
  second.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test('withLock releases when fn throws and when fn rejects', async () => {
  const dir = tempDir();
  const lockPath = path.join(dir, 'bot.lock');
  await assert.rejects(
    () => withLock(lockPath, { waitMs: 0 }, () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(fs.existsSync(lockPath), false);
  await assert.rejects(
    () => withLock(lockPath, { waitMs: 0 }, async () => { throw new Error('async-boom'); }),
    /async-boom/,
  );
  assert.equal(fs.existsSync(lockPath), false);
});

test('renameWithRetry retries EPERM/EBUSY then succeeds; other errors immediate', () => {
  let attempts = 0;
  renameWithRetry('a', 'b', {
    attempts: 5,
    sleepSync: () => {},
    rename: () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('busy');
        err.code = attempts === 1 ? 'EPERM' : 'EBUSY';
        throw err;
      }
    },
  });
  assert.equal(attempts, 3);

  attempts = 0;
  assert.throws(
    () => renameWithRetry('a', 'b', {
      attempts: 2,
      sleepSync: () => {},
      rename: () => {
        attempts += 1;
        const err = new Error('busy');
        err.code = 'EPERM';
        throw err;
      },
    }),
    (error) => error.code === 'EPERM',
  );
  assert.equal(attempts, 2);

  assert.throws(
    () => renameWithRetry('a', 'b', {
      attempts: 5,
      sleepSync: () => {},
      rename: () => {
        const err = new Error('nope');
        err.code = 'ENOENT';
        throw err;
      },
    }),
    (error) => error.code === 'ENOENT',
  );
});
