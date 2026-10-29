// Fail-closed advisory file locks for local disk only. Never auto-stolen.
// Residual risk: if an operator breaks a lock while a holder is alive, concurrent
// state-file writes can overwrite another bot's pending record (lost pending,
// causing a duplicate or a lost report), which is why breaking is explicit and
// operator-asserted; a crashed poster leaves its lock until an operator breaks
// it, blocking that bot's reports (exit 3, lock_timeout) meanwhile.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

const DEFAULT_ATTEMPTS = 5;
const RENAME_DELAY_MS = 20;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readLockDiagnostics(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      pid: parsed.pid,
      host: parsed.host,
      token: parsed.token,
      acquired_at: parsed.acquired_at,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function breakLockFile(lockPath) {
  const diagnostics = readLockDiagnostics(lockPath);
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return diagnostics;
}

export async function acquireLock(lockPath, {
  waitMs = 0,
  pollMs = 50,
  now = () => new Date(),
  sleep = defaultSleep,
  host = os.hostname(),
} = {}) {
  // Wait budget is always wall-clock so a frozen poster `now` (report timestamps)
  // cannot pin elapsed at 0 and hang forever. `now` still stamps acquired_at.
  const startedWall = Date.now();
  const token = crypto.randomBytes(16).toString('hex');
  let delay = pollMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        const payload = JSON.stringify({
          pid: process.pid,
          host,
          token,
          acquired_at: now().toISOString(),
        });
        fs.writeFileSync(fd, payload);
      } finally {
        fs.closeSync(fd);
      }
      return {
        token,
        release() {
          const current = readLockDiagnostics(lockPath);
          if (current && current.token === token) {
            try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
        },
      };
    } catch (error) {
      // Windows returns EPERM, not EEXIST, when the lock file is still delete-pending
      // after the previous holder's unlink; that is contention, not a real failure.
      const busy = error.code === 'EEXIST' || (process.platform === 'win32' && error.code === 'EPERM');
      if (!busy) throw error;
      const elapsed = Date.now() - startedWall;
      if (elapsed >= waitMs) {
        const diagnostics = readLockDiagnostics(lockPath);
        throw Object.assign(new Error(`LOCK_TIMEOUT: ${lockPath}`), {
          code: 'LOCK_TIMEOUT',
          lockPath,
          diagnostics,
        });
      }
      await sleep(Math.min(delay, Math.max(0, waitMs - elapsed)));
      delay = Math.min(delay * 2, 500);
    }
  }
}

export async function withLock(lockPath, options, fn) {
  const handle = await acquireLock(lockPath, options);
  try {
    return await fn(handle);
  } finally {
    handle.release();
  }
}

export function renameWithRetry(from, to, {
  attempts = DEFAULT_ATTEMPTS,
  sleepSync = (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy wait for sync path used by state writes */ }
  },
  rename = fs.renameSync,
} = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
      if (i + 1 >= attempts) break;
      sleepSync(RENAME_DELAY_MS);
    }
  }
  throw lastError;
}
