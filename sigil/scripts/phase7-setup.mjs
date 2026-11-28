#!/usr/bin/env node
// Phase 7 owner-run setup, Task 6: the entry point and phase sequencing.
//
//   node sigil/scripts/phase7-setup.mjs [--config <path>] [--apply] [--help]
//
// Rules this file keeps:
// - --help needs nothing: no config, database, credential or file.
// - With no --apply the run only reads and prints the plan. It creates no file,
//   directory, lock or prompt and writes nothing to a database.
// - --apply needs an interactive terminal and the typed phrase
//   `APPLY PHASE7 <dbLabel>` before anything is written. Any blocker in the
//   plan stops it first. Each bot then needs its own `CREATE <endpoint>`.
// - The setup lock is always released: Ctrl-C during the apply stage is caught
//   so cleanup runs instead of Node exiting with the lock file left behind.
// - Output is the allowlisted summary. Errors print a fixed code and message,
//   never a value, raw error, stack or argument.
//
// Exit codes (SPEC §4): 0 ready or help, 2 missing or blocked prerequisites,
// 3 declined or confirmation needed, 4 failed or partial apply.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSetupArgs, validateSetupConfig, planSetup, renderSummary, authorized } from '../cli/phase7-setup-policy.mjs';
import { STORAGE_MESSAGES } from '../cli/phase7-setup-storage.mjs';
import { applySetup, applyPhrase, applyPrechecks, renderApplyResult } from '../cli/phase7-setup-apply.mjs';

export const EXIT = Object.freeze({ OK: 0, INCOMPLETE: 2, DECLINED: 3, FAILED: 4 });
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const REQUIRED_CONFIG_FIELDS = Object.freeze([
  'secretRoot', 'operatorIdentityPath', 'registryPath', 'dbLabel', 'databaseEnv',
  'wrapKeyRef', 'relayDomain', 'routine', 'bots',
]);

export const USAGE = [
  'Phase 7 owner-run setup',
  '',
  'Usage: node sigil/scripts/phase7-setup.mjs [--config <path>] [--apply] [--help]',
  '',
  '  --config <path>  setup.json with paths, IDs and env var names only, never values',
  '                   (default: <home>\\.sigil-secrets\\phase7\\setup.json)',
  '  --apply          store missing routine inputs and create missing bots, after',
  '                   typed confirmation in an interactive terminal',
  '  --help           show this help',
  '',
  'Without --apply the run only inspects and prints the plan. It never runs the',
  'live Grok smoke, restarts a relay or calls the routine.',
].join('\n');

const NO_SMOKE = 'live Grok smoke NOT RUN';
const SAFE_TEXT = /^[A-Za-z0-9 _.,:;@#()[\]<>'/-]{1,160}$/;
const safeText = (text) => (typeof text === 'string' && SAFE_TEXT.test(text) ? text : '[redacted]');
const ROUTINE_FIELDS = Object.freeze([['routine_url', 'urlState'], ['sender_key', 'keyState']]);
const ROUTINE_OK = new Set(['present', 'missing']);

// Storage error code -> exit code. Anything not listed is a failed run.
const STORAGE_EXIT = Object.freeze({
  PROMPT_CANCELLED: EXIT.DECLINED,
  SETUP_LOCKED: EXIT.INCOMPLETE,
  ROUTINE_NEEDS_REVIEW: EXIT.INCOMPLETE,
  CREDENTIAL_STORE_UNAVAILABLE: EXIT.INCOMPLETE,
  CREDENTIAL_EXISTS: EXIT.INCOMPLETE,
  STORAGE_PATH_REJECTED: EXIT.INCOMPLETE,
  STORAGE_ACL_UNSUPPORTED: EXIT.INCOMPLETE,
  STORAGE_ACL_FAILED: EXIT.INCOMPLETE,
  INVALID_ROUTINE_VALUE: EXIT.INCOMPLETE,
});

class Interrupted extends Error {
  constructor() { super('interrupted'); this.code = 'INTERRUPTED'; }
}

// A planned stop with a fixed line for the owner, not an error.
class Stopped extends Error {
  constructor(line) { super('stopped'); this.line = line; }
}

export function defaultConfigPath(home, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(home, '.sigil-secrets', 'phase7', 'setup.json');
}

function errorLine(error) {
  const code = typeof error?.code === 'string' && /^[A-Z_]{1,40}$/.test(error.code) ? error.code : 'SETUP_FAILED';
  const message = STORAGE_MESSAGES[code] ?? (code === 'INTERRUPTED' ? 'interrupted; nothing further was changed' : 'setup stopped on an unexpected error');
  const detail = typeof error?.detail === 'string' && /^[a-z0-9-]{1,40}$/.test(error.detail) ? ` (${error.detail})` : '';
  return `Error ${code}: ${message}${detail}`;
}

// One read-only snapshot: protected-storage sources, the database inspection,
// the registry file preflight and the automatic-refresh check. Routine inputs
// that need review, or a rejected secret root, become blockers so apply stops
// before collecting anything.
async function takeSnapshot(config, storage, deps) {
  const sources = await storage.inspectSources(config);
  const db = await deps.inspectDatabase(config);
  const registryPreflight = await deps.preflightRegistry(config);
  // Only the live relay check can verify refresh. registryRefreshConfirmed in
  // setup.json is still accepted so old files load, but it is ignored and the
  // summary says so.
  const probe = await deps.probeRegistryRefresh(config);
  const registryRefresh = typeof probe === 'string' ? probe : (probe?.status ?? 'unverified');
  const refreshOverrideIgnored = config?.registryRefreshConfirmed !== undefined;
  const blockers = [...(db?.blockers ?? [])];
  if (sources.secretRoot === 'rejected') blockers.push('secret-root-rejected');
  if (sources.routine.keyHeader !== 'valid') blockers.push('routine-key-header-invalid');
  for (const [name, prop] of ROUTINE_FIELDS) {
    const state = sources.routine[prop];
    if (!ROUTINE_OK.has(state) && sources.secretRoot !== 'rejected') blockers.push(`${name}-${state}`);
  }
  return {
    ...db,
    bots: db?.bots ?? [],
    routine: { urlState: sources.routine.urlState, keyState: sources.routine.keyState },
    registryPreflight,
    registryRefresh,
    refreshOverrideIgnored,
    blockers,
  };
}

const missingRoutine = (plan) => plan.inputs.filter((i) => (i.name === 'routine_url' || i.name === 'sender_key') && i.state === 'missing').map((i) => i.name);

// The non-secret part of the database URL: host, port and database name, never
// the user, password or query options. The typed phrase names dbLabel, which is
// only a label in setup.json, so this line shows what the URL really points at.
const DB_PART = /^[A-Za-z0-9_.\-[\]:/]{1,100}$/;
export function describeDatabaseTarget(url) {
  if (typeof url !== 'string' || url === '') return 'database target: unknown (database env var is not set)';
  let parsed;
  try { parsed = new URL(url); } catch { return 'database target: unknown (not a postgres:// URL; check it before typing the phrase)'; }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return 'database target: unknown (not a postgres:// URL; check it before typing the phrase)';
  }
  const decode = (v) => { try { return decodeURIComponent(v); } catch { return ''; } };
  const show = (v, fallback) => (!v ? fallback : DB_PART.test(v) ? v : '[unreadable]');
  const host = show(parsed.hostname || parsed.searchParams.get('host'), 'local socket');
  const name = show(decode(parsed.pathname.replace(/^\//, '')) || parsed.searchParams.get('dbname'), '(default for the user)');
  return `database target: host ${host}${parsed.port ? `:${parsed.port}` : ''}, database ${name}`;
}


function describeWrites(config, plan, env) {
  const lines = ['Apply will:'];
  const fields = missingRoutine(plan);
  if (fields.length) lines.push(`- prompt for ${fields.join(', ')} (hidden) and store them in the protected secret root`);
  if (plan.create.length) {
    lines.push(`- create ${plan.create.map((b) => safeText(b.endpointId)).join(', ')} with sigil bot add, one typed CREATE phrase each`);
    lines.push('- sigil bot add also applies any pending migrations; setup has checked none are pending');
  }
  lines.push(`- database: ${safeText(config.dbLabel)}`);
  lines.push(`- ${describeDatabaseTarget(env?.[config.databaseEnv])}`);
  return lines.join('\n');
}

// applySetup asks for the whole-run phrase itself. The owner already typed it
// once in this run, so that one prompt is answered with what they typed. Every
// other prompt (each CREATE phrase) goes to the owner. After an interrupt,
// nothing more is asked and every remaining bot reads as declined.
function confirmAfterApproval(confirm, entered, dbLabel, state) {
  let replayed = false;
  const runPrompt = `Type ${applyPhrase(dbLabel)} `;
  return async (question) => {
    if (state.interrupted) return null;
    if (!replayed && typeof question === 'string' && question.startsWith(runPrompt)) { replayed = true; return entered; }
    const answer = await confirm(question);
    return state.interrupted ? null : answer;
  };
}

function applyExit(status) {
  if (status === 'completed' || status === 'nothing-to-create') return EXIT.OK;
  if (status === 'declined' || status === 'not-a-tty') return EXIT.DECLINED;
  if (status === 'blocked' || status === 'dry-run') return EXIT.INCOMPLETE;
  return EXIT.FAILED;
}

export async function main(argv, deps) {
  const out = (text) => deps.out(text);

  let args;
  try {
    args = parseSetupArgs(argv);
  } catch (error) {
    out(`Error INVALID_SETUP_ARGS: ${safeText(error?.message)}`);
    return EXIT.INCOMPLETE;
  }
  if (args.help) { out(USAGE); return EXIT.OK; }

  // Config: missing is a requirements summary, invalid names the field only.
  const configPath = args.configPath ?? defaultConfigPath(deps.home, deps.platform);
  let raw;
  try {
    raw = await deps.readConfig(configPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      out([
        'Mode: dry-run; Phase 7 paused; active track: one-link enrollment',
        `config: missing (${args.configPath ? '--config path' : 'default location'})`,
        `required fields: ${REQUIRED_CONFIG_FIELDS.join(', ')}`,
        'Values never go in the config: only paths, IDs and env var or credential names.',
        `Result: setup incomplete; ${NO_SMOKE}`,
      ].join('\n'));
      return EXIT.INCOMPLETE;
    }
    out(`config: invalid (${error?.code === 'CONFIG_NOT_JSON' ? 'not JSON' : 'unreadable'})\nResult: setup incomplete; ${NO_SMOKE}`);
    return EXIT.INCOMPLETE;
  }
  let config;
  try {
    config = validateSetupConfig(raw, { repoRoot: deps.repoRoot ?? REPO_ROOT });
  } catch (error) {
    out(`config: invalid (${safeText(error?.message)})\nResult: setup incomplete; ${NO_SMOKE}`);
    return EXIT.INCOMPLETE;
  }

  // Read-only inspection and plan. Dry-run storage refuses every effect.
  const readStorage = deps.createStorage({ mode: 'dry-run' });
  let plan;
  try {
    plan = planSetup(await takeSnapshot(config, readStorage, deps), { apply: args.apply, configBots: config.bots, databaseEnv: config.databaseEnv });
  } catch (error) {
    out(`${errorLine(error)}\nResult: setup incomplete; ${NO_SMOKE}`);
    return EXIT.INCOMPLETE;
  } finally {
    await readStorage.close();
  }
  out(renderSummary(plan));
  if (!args.apply) return plan.fourInputsReady ? EXIT.OK : EXIT.INCOMPLETE;

  // Apply gates, in order, each with no effect.
  if (deps.isTTY !== true) {
    out('apply: needs an interactive terminal; nothing was changed');
    return EXIT.DECLINED;
  }
  if (plan.blockers.length) {
    out('apply: refused until the blockers above are cleared; nothing was changed');
    return EXIT.INCOMPLETE;
  }
  const fields = missingRoutine(plan);
  if (fields.length === 0 && plan.create.length === 0) {
    out('apply: nothing to store or create; nothing was changed');
    return plan.fourInputsReady ? EXIT.OK : EXIT.INCOMPLETE;
  }
  // What bot creation needs is checked before anything is written, so a run
  // that could not create its bots does not store routine inputs either.
  const pre = plan.create.length ? applyPrechecks(config, plan, deps.env) : [];
  if (pre.length) {
    out(`apply: refused until these are fixed: ${pre.map(safeText).join(', ')}; nothing was changed`);
    if (pre.includes('db-label-mismatch')) out(`apply: dbLabel in setup.json must be the database name in ${safeText(config.databaseEnv)}; ${describeDatabaseTarget(deps.env?.[config.databaseEnv])}`);
    return EXIT.INCOMPLETE;
  }
  out(describeWrites(config, plan, deps.env));
  const entered = await deps.confirm(`Type ${applyPhrase(config.dbLabel)} to continue: `);
  if (!authorized({ apply: true, isTTY: deps.isTTY, entered, dbLabel: config.dbLabel })) {
    out('apply: declined; nothing was changed');
    return EXIT.DECLINED;
  }

  // From here on there are effects, so the lock is always released.
  const state = { interrupted: false };
  // A signal also ends any confirmation that is waiting, so the run reaches
  // its cleanup instead of waiting on input that will not come.
  const onSignal = () => {
    if (!state.interrupted) out('apply: stopping after the current step and releasing the setup lock');
    state.interrupted = true;
    deps.cancelPrompts?.();
  };
  const signals = deps.signals;
  signals?.on('SIGINT', onSignal);
  signals?.on('SIGTERM', onSignal);
  const storage = deps.createStorage({ mode: 'apply' });
  const stopIfInterrupted = () => { if (state.interrupted) throw new Interrupted(); };
  const lines = [];
  let code = EXIT.OK;
  try {
    await storage.prepare(config);
    await storage.lock();
    stopIfInterrupted();

    // Re-inspect under the lock; the plan the owner saw only limits this one.
    const fresh = planSetup(await takeSnapshot(config, storage, deps), { apply: true });
    if (fresh.blockers.length) {
      lines.push(`apply: stopped; fresh inspection found blockers: ${fresh.blockers.map(safeText).join(', ')}`);
      code = EXIT.INCOMPLETE;
    } else {
      // Only the inputs the owner approved are collected. One that went
      // missing since the plan was shown stops the run for a new look.
      const freshMissing = missingRoutine(fresh);
      const unapproved = freshMissing.filter((name) => !fields.includes(name));
      if (unapproved.length) throw new Stopped(`apply: stopped; ${unapproved.join(', ')} went missing after the plan was shown; run setup again`);
      if (freshMissing.length) {
        const handle = await storage.collectMissing(config);
        stopIfInterrupted();
        const written = await storage.persistRoutine(handle);
        lines.push(`routine inputs stored: ${written.fields.join(', ') || 'none'}`);
      }
      stopIfInterrupted();
      if (plan.create.length) {
        // The plan the owner approved limits what is created; applySetup
        // inspects again and refuses any bot that plan did not list.
        const result = await applySetup({
          config,
          plan,
          storage,
          inspect: () => takeSnapshot(config, storage, deps),
          confirm: confirmAfterApproval(deps.confirm, entered, config.dbLabel, state),
          spawn: deps.spawn,
          isTTY: deps.isTTY,
          env: deps.env,
          execPath: deps.execPath,
        });
        lines.push(renderApplyResult(result));
        code = applyExit(result.status);
      }
    }
  } catch (error) {
    lines.push(error instanceof Stopped ? error.line : errorLine(error));
    code = error instanceof Stopped ? EXIT.INCOMPLETE
      : error instanceof Interrupted ? EXIT.DECLINED : (STORAGE_EXIT[error?.code] ?? EXIT.FAILED);
  } finally {
    try { await storage.close(); } catch { lines.push('Error STORAGE_CLOSE_FAILED: the setup lock may need removing by hand'); code = EXIT.FAILED; }
    signals?.removeListener('SIGINT', onSignal);
    signals?.removeListener('SIGTERM', onSignal);
  }
  lines.push(`Result: ${code === EXIT.OK ? 'apply finished' : 'setup incomplete'}; ${NO_SMOKE}`);
  out(lines.join('\n'));
  return code;
}

// Asks the relay on loopback whether it refreshes the registry by itself. The
// answer must look like Sigil's relay: status ok and its request-id header.
// That is a sanity check against a different service on the port, not proof:
// the endpoint is unauthenticated, so any local process could imitate it.
export async function probeLiveRegistryRefresh(config, { fetch = globalThis.fetch } = {}) {
  const relayPort = config?.ports?.relay;
  if (!Number.isInteger(relayPort) || relayPort <= 0 || typeof fetch !== 'function') return 'unverified';
  try {
    const res = await fetch(`http://127.0.0.1:${relayPort}/v1/health`, { signal: AbortSignal.timeout(2000) });
    if (!res?.ok) return 'unverified';
    const requestId = typeof res.headers?.get === 'function' ? res.headers.get('x-sigil-request-id') : null;
    if (typeof requestId !== 'string' || requestId === '') return 'unverified';
    const body = await res.json();
    return body?.status === 'ok' && body?.registry_refresh === true ? 'verified' : 'unverified';
  } catch {
    return 'unverified';
  }
}

// Only the relay can verify automatic refresh. A bot the relay cannot pick up
// is never created, so nothing in setup.json can stand in for this check.
export async function probeRegistryRefreshStatus(config, { fetch = globalThis.fetch } = {}) {
  return probeLiveRegistryRefresh(config, { fetch });
}

// Real capabilities, wired only when the script is run directly. Each one is
// created lazily, so --help loads no database driver and reads no file.
export async function realDeps() {
  const [{ default: fsp }, fs, os, { spawn }, readline, { createSetupStorage }, { readCredential, parseCredentialRef }] = await Promise.all([
    import('node:fs/promises'), import('node:fs'), import('node:os'), import('node:child_process'), import('node:readline'),
    import('../cli/phase7-setup-storage.mjs'), import('../cli/credential-store.mjs'),
  ]);
  let home = os.homedir();
  try { home = fs.realpathSync.native(home); } catch { /* keep homedir */ }

  const readJson = async (file) => {
    const text = await fsp.readFile(file, 'utf8');
    try { return JSON.parse(text); } catch { throw Object.assign(new Error('not JSON'), { code: 'CONFIG_NOT_JSON' }); }
  };
  const readJsonOrNull = async (file) => {
    try { return await readJson(file); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  };

  // Readline takes Ctrl-C itself while it reads, so it is passed on as the
  // process's SIGINT: the run then stops, rather than reading it as one
  // declined phrase and asking about the next bot.
  const active = new Set();
  const confirm = (question) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      active.delete(finish);
      rl.close();
      resolve(typeof answer === 'string' ? answer : null);
    };
    active.add(finish);
    rl.on('SIGINT', () => { process.stderr.write('\n'); finish(null); process.emit('SIGINT', 'SIGINT'); });
    rl.on('close', () => finish(null));
    rl.question(question, finish);
  });
  const cancelPrompts = () => { for (const finish of [...active]) finish(null); };

  return {
    out: (text) => process.stdout.write(`${text}\n`),
    home,
    platform: process.platform,
    env: process.env,
    isTTY: process.stdin.isTTY === true && process.stderr.isTTY === true,
    repoRoot: REPO_ROOT,
    execPath: process.execPath,
    spawn,
    signals: process,
    confirm,
    cancelPrompts,
    readConfig: readJson,
    createStorage: ({ mode }) => createSetupStorage({
      fs: fsp,
      spawn,
      platform: process.platform,
      home,
      repoRoots: [REPO_ROOT],
      env: process.env,
      readCredential: async (ref) => readCredential(parseCredentialRef(ref)),
      mode,
      ui: { write: (text) => process.stderr.write(text) },
    }),
    preflightRegistry: async (config) => {
      const { preflightRegistryFile } = await import('../cli/registry-store.mjs');
      return preflightRegistryFile(config.registryPath);
    },
    probeRegistryRefresh: (config) => probeRegistryRefreshStatus(config),
    async inspectDatabase(config) {
      const { inspectSetup } = await import('../cli/phase7-setup-inspect.mjs');
      const unverified = (reason) => ({ inspection: 'unverified', schemaReady: false, bots: [], blockers: [reason] });
      const url = process.env[config.databaseEnv];
      if (typeof url !== 'string' || url === '') return unverified('database-env-missing');
      let ownerId;
      try { ownerId = (await readJson(config.operatorIdentityPath))?.owner_id; } catch { ownerId = undefined; }
      if (typeof ownerId !== 'string' || ownerId === '') return unverified('operator-identity-unreadable');
      const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
      const migrationNames = (await fsp.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
      const { default: pg } = await import('pg');
      const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000, max: 1 });
      pool.on('error', () => {});
      try {
        return await inspectSetup({ ...config, operatorOwnerId: ownerId }, {
          pool,
          readIdentity: readJsonOrNull,
          readRegistry: () => readJsonOrNull(config.registryPath),
          migrationNames,
        });
      } finally {
        await pool.end().catch(() => {});
      }
    },
  };
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  const here = fileURLToPath(import.meta.url);
  const invoked = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? here.toLowerCase() === invoked.toLowerCase() : here === invoked;
}

if (isDirectRun()) {
  try {
    process.exitCode = await main(process.argv.slice(2), await realDeps());
  } catch (error) {
    process.stdout.write(`${errorLine(error)}\nResult: setup incomplete; ${NO_SMOKE}\n`);
    process.exitCode = EXIT.FAILED;
  }
}
