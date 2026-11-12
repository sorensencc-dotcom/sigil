// Phase 7 owner-run setup, Task 4: hidden collection, external paths and
// protected storage. Everything with side effects is injected (fs, spawn, env,
// credential reader), so tests run on fakes and the real Windows path runs the
// narrow helper in phase7-setup-windows.ps1.
//
// Rules this module keeps:
// - Dry run (the default mode) creates no directory, lock, prompt or file.
// - The protected root is verified (owner, SYSTEM and Administrators only,
//   inheritance disabled) before any prompt or secret write. An existing loose
//   ACL is reported, never silently tightened. POSIX file modes are not accepted.
// - Secrets never travel in argv, a -Command string or child env. A prompted
//   value comes back only on the helper's private stdout pipe.
// - Routine credentials are written atomically inside the protected root and
//   never overwrite an existing file. There are no backups.
// - Errors carry a fixed message, a code and an allowlisted detail. They never
//   wrap the underlying exception, helper output or a value.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';

const W = path.win32;
const HELPER_PATH = fileURLToPath(new URL('./phase7-setup-windows.ps1', import.meta.url));
const FRAME = 'SIGIL-HELPER:';
const MAX_HELPER_STDOUT = 64 * 1024;

export const ROUTINE_FILE = 'routine.credentials.json';
export const LOCK_FILE = 'phase7-setup.lock';
export const CHECKPOINT_FILE = 'phase7-setup-checkpoint.json';

// Child processes get only what Windows and PowerShell need to start.
export const CHILD_ENV_ALLOWLIST = Object.freeze([
  'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'PATH', 'TEMP', 'TMP',
  'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'LOCALAPPDATA', 'APPDATA', 'PSModulePath',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS',
]);

export const STORAGE_MESSAGES = Object.freeze({
  DRY_RUN_NO_EFFECTS: 'dry run: protected storage makes no changes',
  STORAGE_PATH_REJECTED: 'path rejected for protected storage',
  STORAGE_ACL_UNSUPPORTED: 'protected storage needs Windows ACLs; POSIX file modes are not accepted',
  STORAGE_ACL_FAILED: 'protected storage ACL check failed',
  STORAGE_NOT_READY: 'protected storage is not prepared and locked',
  STORAGE_HELPER_FAILED: 'Windows helper failed',
  STORAGE_HELPER_TIMEOUT: 'Windows helper timed out',
  STORAGE_WRITE_FAILED: 'protected write failed',
  STORAGE_VERIFY_FAILED: 'protected write could not be verified',
  STORAGE_CLOSED: 'protected storage is closed',
  SETUP_LOCKED: 'another setup run holds the setup lock',
  CREDENTIAL_EXISTS: 'stored routine credentials already exist and are never overwritten',
  CREDENTIAL_STORE_UNAVAILABLE: 'credential store unavailable',
  ROUTINE_NEEDS_REVIEW: 'routine inputs need review before anything is collected',
  INVALID_ROUTINE_VALUE: 'the entered value is not valid',
  PROMPT_CANCELLED: 'hidden prompt was cancelled',
  INVALID_PRIVATE_VALUES: 'unknown private values handle',
  INVALID_CHECKPOINT: 'checkpoint metadata is not allowlisted',
});

export class SetupStorageError extends Error {
  constructor(code, detail) {
    super(STORAGE_MESSAGES[code] ?? STORAGE_MESSAGES.STORAGE_HELPER_FAILED);
    this.code = STORAGE_MESSAGES[code] ? code : 'STORAGE_HELPER_FAILED';
    if (typeof detail === 'string' && /^[a-z0-9-]{1,40}$/.test(detail)) this.detail = detail;
  }
}
SetupStorageError.prototype.name = 'SetupStorageError';

const fail = (code, detail) => { throw new SetupStorageError(code, detail); };

// --- value validation (format only; authenticity is never probed) ---------

export function isValidRoutineUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  if (/[\u0000-\u0020\u007f\\#]/.test(value)) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hostname !== '' && url.hash === '';
}

export function isValidSenderKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
}

const HEADER_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'cookie',
  'set-cookie', 'te', 'trailer', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'expect']);

// keyHeader is "Name" or "Name: Scheme", matching the Floor Warden bridge.
export function isValidKeyHeader(spec) {
  if (spec === undefined) return true;
  if (typeof spec !== 'string') return false;
  const colon = spec.indexOf(':');
  const name = (colon === -1 ? spec : spec.slice(0, colon)).trim();
  const scheme = colon === -1 ? '' : spec.slice(colon + 1).trim();
  if (!HEADER_TOKEN.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) return false;
  return scheme === '' || HEADER_TOKEN.test(scheme);
}

// --- path validation --------------------------------------------------------

const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

function rawPathProblem(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 240) return 'invalid';
  if (/[\u0000-\u001f]/.test(p)) return 'control-character';
  if (/^[\\/]{2}/.test(p)) return 'unc-or-device';
  if (!/^[A-Za-z]:[\\/]/.test(p)) return 'not-absolute';
  const segments = p.slice(3).split(/[\\/]/);
  if (segments.at(-1) === '') segments.pop();
  for (const seg of segments) {
    if (seg === '') return 'empty-segment';
    if (seg === '.' || seg === '..') return 'traversal';
    if (/[<>:"|?*]/.test(seg)) return 'unsafe-name';
    if (/[. ]$/.test(seg)) return 'unsafe-name';
    if (RESERVED.test(seg.split('.')[0].trimEnd())) return 'reserved-name';
    if (/~\d/.test(seg)) return 'short-name';
  }
  return null;
}

const lower = (p) => W.normalize(p).replace(/\\+$/, '').toLowerCase();

function isInside(child, root) {
  const rel = W.relative(lower(root), lower(child));
  return rel === '' || (!rel.startsWith('..') && !W.isAbsolute(rel));
}

const isMissing = (e) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR';

// --- the storage boundary ---------------------------------------------------

class PrivateValues {
  #names;
  constructor(names) { this.#names = Object.freeze([...names]); Object.freeze(this); }
  get names() { return this.#names; }
  toJSON() { return '[private]'; }
  toString() { return '[private]'; }
  [inspect.custom]() { return 'PrivateValues [private]'; }
}

const PHASES = new Set(['prepared', 'collected', 'persisted', 'provisioning', 'provisioned', 'failed']);
const REFRESH_STATES = new Set(['verified', 'unverified', 'unsupported']);
const SAFE_ID = /^[A-Za-z0-9_.@:#-]{1,128}$/;
const CHECKPOINT_LISTS = ['created', 'skipped', 'failed', 'blockers'];
const CHECKPOINT_FIELDS = new Set(['phase', 'registryRefresh', ...CHECKPOINT_LISTS]);

const FIELDS = Object.freeze([
  { name: 'routine_url', prop: 'url', env: 'urlEnv', ref: 'urlRef', valid: isValidRoutineUrl, label: 'Routine webhook URL (input hidden): ', detail: 'routine-url' },
  { name: 'sender_key', prop: 'key', env: 'keyEnv', ref: 'keyRef', valid: isValidSenderKey, label: 'Routine sender key (input hidden): ', detail: 'sender-key' },
]);

export function createSetupStorage({
  fs,
  spawn,
  platform = process.platform,
  home,
  repoRoots = [],
  env = process.env,
  readCredential,
  mode = 'dry-run',
  ui = { write: (line) => process.stderr.write(line) },
  now = () => new Date().toISOString(),
  helperPath = HELPER_PATH,
  powershellPath,
  helperTimeoutMs = 30_000,
  promptTimeoutMs = 10 * 60_000,
} = {}) {
  const events = [];
  const vault = new WeakMap();
  const state = { root: null, prepared: false, locked: false, closed: false };
  const apply = mode === 'apply';

  const systemRoot = typeof env?.SystemRoot === 'string' && /^[A-Za-z]:\\[^\u0000-\u001f]*$/.test(env.SystemRoot) ? env.SystemRoot : 'C:\\Windows';
  const psPath = powershellPath ?? W.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const childEnv = Object.freeze(Object.fromEntries(
    CHILD_ENV_ALLOWLIST.filter((k) => typeof env?.[k] === 'string').map((k) => [k, env[k]]),
  ));

  const requireApply = () => { if (!apply) fail('DRY_RUN_NO_EFFECTS'); };
  const requireOpen = () => { if (state.closed) fail('STORAGE_CLOSED'); };
  const requireReady = () => { requireApply(); requireOpen(); if (!state.prepared || !state.locked) fail('STORAGE_NOT_READY'); };

  function runHelper(action, args = [], { interactive = false, timeoutMs = helperTimeoutMs } = {}) {
    const argv = ['-NoProfile', ...(interactive ? [] : ['-NonInteractive']), '-ExecutionPolicy', 'Bypass',
      '-File', helperPath, '-Action', action, ...args];
    return new Promise((resolve) => {
      let child;
      try {
        // stdin is the console only for the hidden prompt (keystrokes, masked
        // by Read-Host). stdout and stderr are always private pipes.
        child = spawn(psPath, argv, {
          stdio: [interactive ? 'inherit' : 'pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
          env: childEnv,
          cwd: home,
        });
      } catch {
        resolve({ kind: 'spawn-failed' });
        return;
      }
      const chunks = [];
      let size = 0;
      let settled = false;
      const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
      const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish({ kind: 'timeout' }); }, timeoutMs);
      child.stdin?.end?.();
      child.stdout.on('data', (chunk) => { size += chunk.length; if (size <= MAX_HELPER_STDOUT) chunks.push(Buffer.from(chunk)); });
      child.stderr.resume(); // drained, never read
      child.on('error', () => finish({ kind: 'spawn-failed' }));
      child.on('close', () => {
        const buffer = Buffer.concat(chunks);
        chunks.length = 0;
        const frames = buffer.toString('utf8').split(/\r?\n/).filter((l) => l.startsWith(FRAME)).map((l) => l.slice(FRAME.length));
        buffer.fill(0);
        const last = frames.at(-1);
        if (last === 'OK') finish({ kind: 'ok' });
        else if (last?.startsWith('SECRET:') && /^[A-Za-z0-9+/]*={0,2}$/.test(last.slice(7))) {
          const bytes = Buffer.from(last.slice(7), 'base64');
          const value = bytes.toString('utf8');
          bytes.fill(0);
          finish({ kind: 'secret', value });
        } else if (last?.startsWith('ERR:')) {
          const reason = last.slice(4);
          finish({ kind: 'error', reason: /^[A-Z_]{1,40}$/.test(reason) ? reason : 'UNKNOWN' });
        } else finish({ kind: 'no-frame' });
      });
    });
  }

  async function verifyAcl(target, kind, detail) {
    events.push('acl-verify');
    const result = await runHelper('VerifyAcl', ['-Path', target, '-Kind', kind]);
    if (result.kind !== 'ok') fail('STORAGE_ACL_FAILED', detail);
  }

  async function lstatOrNull(target) {
    try { return await fs.lstat(target); } catch (e) { if (isMissing(e)) return null; fail('STORAGE_PATH_REJECTED', 'unreadable'); }
    return null;
  }

  // Raw-name checks, home and repo containment, then a read-only walk from the
  // drive root: no reparse point (symlink or junction) and no Git worktree on
  // the way, and the deepest existing ancestor must already be canonical.
  async function validatePath(raw) {
    const problem = rawPathProblem(raw);
    if (problem) fail('STORAGE_PATH_REJECTED', problem);
    const target = W.normalize(raw).replace(/\\+$/, '');
    if (typeof home !== 'string' || rawPathProblem(home) || !isInside(target, home) || lower(target) === lower(home)) fail('STORAGE_PATH_REJECTED', 'outside-home');
    for (const repo of repoRoots) if (isInside(target, repo)) fail('STORAGE_PATH_REJECTED', 'inside-repository');
    const parts = target.split('\\');
    let deepest = null;
    let stat = null;
    for (let i = 1; i <= parts.length; i += 1) {
      const prefix = i === 1 ? `${parts[0]}\\` : parts.slice(0, i).join('\\');
      const s = await lstatOrNull(prefix);
      if (!s) break;
      if (s.isSymbolicLink()) fail('STORAGE_PATH_REJECTED', 'reparse-point');
      if (await lstatOrNull(W.join(prefix, '.git'))) fail('STORAGE_PATH_REJECTED', 'git-worktree');
      deepest = prefix;
      stat = i === parts.length ? s : null;
    }
    if (deepest) {
      let real;
      try { real = await fs.realpath(deepest); } catch { fail('STORAGE_PATH_REJECTED', 'unreadable'); }
      if (lower(real) !== lower(deepest)) fail('STORAGE_PATH_REJECTED', 'reparse-point');
    }
    return { path: target, stat };
  }

  async function readStored(root) {
    const file = W.join(root, ROUTINE_FILE);
    const s = await lstatOrNull(file);
    if (!s) return { state: 'absent' };
    if (s.isSymbolicLink() || !s.isFile()) return { state: 'invalid' };
    try {
      const parsed = JSON.parse(String(await fs.readFile(file, 'utf8')));
      const keys = Object.keys(parsed ?? {});
      const ok = parsed && typeof parsed === 'object' && parsed.version === 1
        && keys.every((k) => ['version', 'url', 'key'].includes(k))
        && ['url', 'key'].every((k) => parsed[k] === undefined || typeof parsed[k] === 'string');
      return ok ? { state: 'present', url: parsed.url, key: parsed.key } : { state: 'invalid' };
    } catch {
      return { state: 'invalid' };
    }
  }

  async function fieldState(field, routine, stored) {
    if (stored.state === 'invalid') return 'needs-review';
    const sources = [];
    if (stored.state === 'present' && stored[field.prop] !== undefined) sources.push(stored[field.prop]);
    const envName = routine?.[field.env];
    if (typeof envName === 'string' && typeof env?.[envName] === 'string' && env[envName] !== '') sources.push(env[envName]);
    const ref = routine?.[field.ref];
    if (typeof ref === 'string') {
      // Store failures stay unavailable: no fallback to a file, repo or fake.
      if (typeof readCredential !== 'function') return 'unavailable';
      try {
        const value = await readCredential(ref);
        if (typeof value === 'string' && value !== '') sources.push(value);
      } catch (e) {
        if (e?.code !== 'CREDENTIAL_NOT_FOUND') return 'unavailable';
      }
    }
    if (sources.length === 0) {
      if (stored.state === 'unverified') return 'unverified';
      return stored.state === 'present' ? 'needs-review' : 'missing';
    }
    if (new Set(sources).size > 1) return 'needs-review';
    return field.valid(sources[0]) ? 'present' : 'invalid';
  }

  async function inspectSources(config) {
    requireOpen();
    events.push('inspect');
    let secretRoot = 'rejected';
    let stored = { state: 'unverified' };
    try {
      const root = await validatePath(config?.secretRoot);
      if (root.stat && !root.stat.isDirectory()) throw new SetupStorageError('STORAGE_PATH_REJECTED', 'not-a-directory');
      secretRoot = root.stat ? 'present' : 'absent';
      stored = root.stat ? await readStored(root.path) : { state: 'absent' };
    } catch (e) {
      if (!(e instanceof SetupStorageError)) throw new SetupStorageError('STORAGE_PATH_REJECTED', 'unreadable');
    }
    const routine = config?.routine ?? {};
    const [urlState, keyState] = [await fieldState(FIELDS[0], routine, stored), await fieldState(FIELDS[1], routine, stored)];
    stored = null;
    return Object.freeze({
      secretRoot,
      routine: Object.freeze({ urlState, keyState, keyHeader: isValidKeyHeader(routine.keyHeader) ? 'valid' : 'invalid' }),
    });
  }

  async function prepare(config) {
    requireApply();
    requireOpen();
    if (platform !== 'win32') fail('STORAGE_ACL_UNSUPPORTED');
    // Validate every path before any effect.
    const root = await validatePath(config?.secretRoot);
    const operator = await validatePath(config?.operatorIdentityPath);
    const registry = await validatePath(config?.registryPath);
    const botParents = [];
    for (const bot of config?.bots ?? []) {
      const identity = await validatePath(bot?.identityPath);
      const parent = W.dirname(identity.path);
      if (lower(parent) !== lower(root.path) && !botParents.some((p) => lower(p) === lower(parent))) botParents.push(parent);
    }

    if (!root.stat) {
      if (!(await lstatOrNull(W.dirname(root.path)))) fail('STORAGE_PATH_REJECTED', 'parent-missing');
      events.push('mkdir');
      try { await fs.mkdir(root.path); } catch { fail('STORAGE_WRITE_FAILED', 'secret-root'); }
      const made = await lstatOrNull(root.path);
      if (!made || made.isSymbolicLink() || !made.isDirectory()) fail('STORAGE_PATH_REJECTED', 'reparse-point');
      events.push('acl-set');
      const set = await runHelper('ProtectDir', ['-Path', root.path]);
      if (set.kind !== 'ok') fail('STORAGE_ACL_FAILED', 'secret-root');
    } else if (!root.stat.isDirectory()) {
      fail('STORAGE_PATH_REJECTED', 'not-a-directory');
    }
    // An existing directory is verified as it is, never tightened.
    await verifyAcl(root.path, 'Directory', 'secret-root');

    for (const [file, label] of [[operator, 'operator-identity'], [registry, 'registry']]) {
      const s = await lstatOrNull(file.path);
      if (!s || !s.isFile()) fail('STORAGE_PATH_REJECTED', `${label}-missing`);
      await verifyAcl(file.path, 'File', label);
    }
    for (const parent of botParents) {
      const s = await lstatOrNull(parent);
      if (!s || !s.isDirectory()) fail('STORAGE_PATH_REJECTED', 'identity-parent-missing');
      await verifyAcl(parent, 'Directory', 'identity-parent');
    }
    state.root = root.path;
    state.prepared = true;
    return Object.freeze({ secretRoot: 'protected' });
  }

  async function createExclusive(target, content) {
    const handle = await fs.open(target, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  const tempName = (base) => W.join(state.root, `.${base}.${randomBytes(8).toString('hex')}.tmp`);
  const removeQuietly = async (target) => { try { await fs.unlink(target); } catch { /* already gone */ } };

  async function lock() {
    requireApply();
    requireOpen();
    if (!state.prepared) fail('STORAGE_NOT_READY');
    if (state.locked) return;
    events.push('lock');
    try {
      await createExclusive(W.join(state.root, LOCK_FILE), JSON.stringify({ pid: process.pid, at: now() }));
    } catch (e) {
      // A stale lock is never removed automatically.
      if (e?.code === 'EEXIST') fail('SETUP_LOCKED');
      fail('STORAGE_WRITE_FAILED', 'lock');
    }
    state.locked = true;
  }

  async function prompt(field) {
    ui.write(field.label);
    events.push('prompt');
    const result = await runHelper('Prompt', [], { interactive: true, timeoutMs: promptTimeoutMs });
    if (result.kind === 'secret') return result.value;
    if (result.kind === 'error' && result.reason === 'PROMPT_EMPTY') fail('INVALID_ROUTINE_VALUE', field.detail);
    if (result.kind === 'timeout') fail('STORAGE_HELPER_TIMEOUT', 'prompt');
    return fail('PROMPT_CANCELLED');
  }

  async function collectMissing(config) {
    requireReady();
    const root = await validatePath(config?.secretRoot);
    if (lower(root.path) !== lower(state.root)) fail('STORAGE_NOT_READY');
    const sources = await inspectSources(config);
    const states = [sources.routine.urlState, sources.routine.keyState];
    if (states.includes('unavailable')) fail('CREDENTIAL_STORE_UNAVAILABLE');
    if (sources.routine.keyHeader !== 'valid' || states.some((s) => s !== 'present' && s !== 'missing')) fail('ROUTINE_NEEDS_REVIEW');
    const values = new Map();
    for (const [i, field] of FIELDS.entries()) {
      if (states[i] !== 'missing') continue;
      const value = await prompt(field);
      if (!field.valid(value)) fail('INVALID_ROUTINE_VALUE', field.detail);
      values.set(field.name, value);
    }
    const handle = new PrivateValues([...values.keys()]);
    vault.set(handle, values);
    return handle;
  }

  async function persistRoutine(handle) {
    requireReady();
    const values = vault.get(handle);
    if (!values) fail('INVALID_PRIVATE_VALUES');
    const fields = [...values.keys()];
    if (fields.length === 0) return Object.freeze({ written: false, fields: [] });
    const target = W.join(state.root, ROUTINE_FILE);
    if (await lstatOrNull(target)) fail('CREDENTIAL_EXISTS');
    const record = { version: 1 };
    for (const field of FIELDS) if (values.has(field.name)) record[field.prop] = values.get(field.name);
    let content = JSON.stringify(record);
    const temp = tempName(ROUTINE_FILE);
    try {
      await createExclusive(temp, content);
      try { await fs.link(temp, target); } catch (e) { if (e?.code === 'EEXIST') fail('CREDENTIAL_EXISTS'); throw e; }
    } catch (e) {
      if (e instanceof SetupStorageError) throw e;
      fail('STORAGE_WRITE_FAILED', 'routine-credentials');
    } finally {
      await removeQuietly(temp);
    }
    events.push('write-secret');
    try {
      await verifyAcl(target, 'File', 'routine-credentials');
      let readBack;
      try { readBack = String(await fs.readFile(target, 'utf8')); } catch { readBack = null; }
      if (readBack !== content) fail('STORAGE_VERIFY_FAILED', 'routine-credentials');
    } catch (e) {
      await removeQuietly(target);
      throw e;
    } finally {
      content = null;
      values.clear();
      vault.delete(handle);
    }
    return Object.freeze({ written: true, fields });
  }

  async function checkpoint(meta) {
    requireReady();
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) fail('INVALID_CHECKPOINT');
    for (const key of Object.keys(meta)) if (!CHECKPOINT_FIELDS.has(key)) fail('INVALID_CHECKPOINT');
    if (!PHASES.has(meta.phase)) fail('INVALID_CHECKPOINT');
    const registryRefresh = meta.registryRefresh ?? 'unverified';
    if (!REFRESH_STATES.has(registryRefresh)) fail('INVALID_CHECKPOINT');
    const record = { version: 1, mode: 'apply', phase: meta.phase, registryRefresh, at: now() };
    for (const list of CHECKPOINT_LISTS) {
      const items = meta[list] ?? [];
      if (!Array.isArray(items) || items.length > 64 || !items.every((v) => typeof v === 'string' && SAFE_ID.test(v))) fail('INVALID_CHECKPOINT');
      record[list] = [...items];
    }
    const target = W.join(state.root, CHECKPOINT_FILE);
    const temp = tempName(CHECKPOINT_FILE);
    events.push('checkpoint');
    try {
      await createExclusive(temp, JSON.stringify(record));
      await fs.rename(temp, target);
    } catch {
      fail('STORAGE_WRITE_FAILED', 'checkpoint');
    } finally {
      await removeQuietly(temp);
    }
    return Object.freeze({ written: true });
  }

  // For the next tasks: call before any DB write or bot add.
  function assertReady() {
    requireReady();
  }

  async function close() {
    if (state.closed) return;
    if (state.locked) {
      events.push('unlock');
      await removeQuietly(W.join(state.root, LOCK_FILE));
      state.locked = false;
    }
    state.closed = true;
  }

  return Object.freeze({
    get events() { return [...events]; },
    inspectSources,
    prepare,
    collectMissing,
    persistRoutine,
    lock,
    checkpoint,
    assertReady,
    close,
  });
}
