// Phase 7 owner-run setup, Task 5: confirmed provisioning through the existing
// `sigil bot add`. Every side effect is injected (storage, inspect, confirm,
// spawn), so tests run on fakes and never touch a real database.
//
// Rules this module keeps:
// - No --apply, no TTY, or a declined phrase means zero effects: no checkpoint,
//   no child process, no further prompt.
// - The plan the owner saw is never trusted on its own. Setup re-inspects while
//   it holds the storage lock and creates only bots that are still missing in
//   that fresh plan and were in the original plan. Anything new stops the run.
// - Automatic registry refresh must be verified in the fresh inspection before
//   any creation. There is no restart path: a bot the relay cannot pick up by
//   itself is never created.
// - Each bot needs its own typed phrase. A declined bot is skipped, not failed.
// - Bots are created only by `sigil bot add`, never by SQL written here.
//   The child gets an allowlisted env, piped stdio and arguments that hold
//   paths, IDs and env var names only. The database URL travels in the child's
//   SIGIL_DATABASE_URL, which is how `bot add` already reads it.
// - The result holds allowlisted IDs and states. Child output is discarded.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSetup, authorized } from './phase7-setup-policy.mjs';
import { CHILD_ENV_ALLOWLIST } from './phase7-setup-storage.mjs';
import { isCredentialRef } from './credential-store.mjs';

const SIGIL_CLI = fileURLToPath(new URL('./sigil.mjs', import.meta.url));
const SAFE = /^[A-Za-z0-9_.@:#-]{1,128}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const POSIX_ENV = Object.freeze(['HOME', 'LANG']);

export const APPLY_STATUSES = Object.freeze([
  'dry-run', 'not-a-tty', 'nothing-to-create', 'declined', 'blocked', 'completed', 'partial', 'failed',
]);
export const BOT_RESULTS = Object.freeze(['created', 'skipped', 'failed']);

export const applyPhrase = (dbLabel) => `APPLY PHASE7 ${dbLabel}`;
export const botPhrase = (endpointId) => `CREATE ${endpointId}`;

const safe = (value) => (typeof value === 'string' && SAFE.test(value) ? value : '[redacted]');
const ids = (list) => list.map((b) => b.botId);

function freezeResult({ status, registryRefresh = 'unverified', blockers = [], bots = [] }) {
  return Object.freeze({
    mode: 'apply',
    status,
    registryRefresh,
    blockers: Object.freeze(blockers.map(safe)),
    bots: Object.freeze(bots.map((b) => Object.freeze({ ...b }))),
  });
}

// Arguments carry paths, IDs, a display name and an env var or credential
// reference name. `--flag=value` keeps a value that starts with -- from being
// read as another flag.
export function botAddArgs(config, bot, cliPath = SIGIL_CLI) {
  return [
    cliPath, 'bot', 'add',
    `--bot-id=${bot.botId}`,
    `--endpoint=${bot.endpointId}`,
    `--name=${bot.displayName}`,
    `--identity=${config.operatorIdentityPath}`,
    `--out=${bot.identityPath}`,
    `--registry=${config.registryPath}`,
    `--room-bot-key-wrap-key=${config.wrapKeyRef}`,
  ];
}

// Returns { env } or { blocker }. Only the allowlist, the database URL and a
// plain-env wrap key reach the child. A credential-store wrap key is read by
// `bot add` itself, so nothing extra is passed for it.
export function botAddEnv(config, env) {
  const out = {};
  for (const key of [...CHILD_ENV_ALLOWLIST, ...POSIX_ENV]) if (typeof env?.[key] === 'string') out[key] = env[key];
  if (typeof config.databaseEnv !== 'string' || !ENV_NAME.test(config.databaseEnv)) return { blocker: 'database-env-invalid' };
  const databaseUrl = env?.[config.databaseEnv];
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) return { blocker: 'database-env-missing' };
  out.SIGIL_DATABASE_URL = databaseUrl;
  if (typeof config.wrapKeyRef !== 'string' || config.wrapKeyRef.length === 0) return { blocker: 'wrap-key-ref-missing' };
  if (!isCredentialRef(config.wrapKeyRef)) {
    if (!ENV_NAME.test(config.wrapKeyRef)) return { blocker: 'wrap-key-ref-invalid' };
    const wrapKey = env?.[config.wrapKeyRef];
    if (typeof wrapKey !== 'string' || wrapKey.length === 0) return { blocker: 'wrap-key-env-missing' };
    out[config.wrapKeyRef] = wrapKey;
  }
  return { env: Object.freeze(out) };
}

// Runs one child with piped stdio. Output is drained and dropped, never kept.
function runChild(spawn, command, args, options, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };
    let child;
    try {
      child = spawn(command, args, options);
    } catch {
      done({ kind: 'spawn-failed' });
      return;
    }
    child.stdout?.resume?.();
    child.stderr?.resume?.();
    child.on('error', () => done({ kind: 'spawn-failed' }));
    child.on('close', (code) => done(code === 0 ? { kind: 'ok' } : { kind: 'exit', code }));
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done({ kind: 'timeout' });
    }, timeoutMs);
  });
}

const failReason = (outcome) => (outcome.kind === 'exit' ? 'bot-add-failed' : `bot-add-${outcome.kind}`);

export async function applySetup({
  config,
  plan,
  storage,
  inspect,
  confirm,
  spawn,
  isTTY,
  env = process.env,
  execPath = process.execPath,
  cliPath = SIGIL_CLI,
  timeoutMs = 120_000,
} = {}) {
  const registryRefresh = plan?.registryRefresh ?? 'unverified';
  // 1. Gates that need no prompt and cause no effect.
  if (plan?.mode !== 'apply') return freezeResult({ status: 'dry-run', registryRefresh });
  if (isTTY !== true) return freezeResult({ status: 'not-a-tty', registryRefresh });
  if (plan.blockers?.length) return freezeResult({ status: 'blocked', registryRefresh, blockers: [...plan.blockers] });
  const skipped = plan.skip.map((b) => ({ botId: b.botId, endpointId: b.endpointId, result: 'skipped', reason: 'healthy' }));
  if (plan.create.length === 0) return freezeResult({ status: 'nothing-to-create', registryRefresh, bots: skipped });

  const byId = new Map((config?.bots ?? []).map((b) => [b.botId, b]));
  const pre = [];
  for (const ref of plan.create) {
    const bot = byId.get(ref.botId);
    if (!bot || bot.endpointId !== ref.endpointId) pre.push(`config-mismatch:${ref.botId}`);
    else if (typeof bot.displayName !== 'string' || bot.displayName.trim() === '') pre.push(`display-name-missing:${ref.botId}`);
  }
  const childEnv = botAddEnv(config ?? {}, env);
  if (childEnv.blocker) pre.push(childEnv.blocker);
  if (pre.length) return freezeResult({ status: 'blocked', registryRefresh, blockers: pre });

  // 2. The whole-run phrase. A wrong or empty answer ends the run with no effect.
  const entered = await confirm(`Type ${applyPhrase(config.dbLabel)} to provision ${plan.create.length} bot(s): `);
  if (!authorized({ apply: true, isTTY, entered, dbLabel: config.dbLabel })) {
    return freezeResult({ status: 'declined', registryRefresh });
  }

  // 3. Storage must be prepared and locked before anything is written.
  storage.assertReady();

  // 4. Re-inspect under the lock. The fresh plan decides; the old one only limits.
  const fresh = planSetup(await inspect(), { apply: true });
  const freshRefresh = fresh.registryRefresh;
  if (fresh.blockers.length) return freezeResult({ status: 'blocked', registryRefresh: freshRefresh, blockers: [...fresh.blockers] });
  const planned = new Set(ids(plan.create));
  const unplanned = fresh.create.filter((b) => !planned.has(b.botId));
  if (unplanned.length) {
    return freezeResult({ status: 'blocked', registryRefresh: freshRefresh, blockers: unplanned.map((b) => `plan-stale:${b.botId}`) });
  }
  if (freshRefresh !== 'verified') {
    return freezeResult({ status: 'blocked', registryRefresh: freshRefresh, blockers: [`registry-refresh-${freshRefresh}`] });
  }
  const freshCreate = new Set(ids(fresh.create));
  const results = fresh.skip.map((b) => ({ botId: b.botId, endpointId: b.endpointId, result: 'skipped', reason: 'healthy' }));
  const toCreate = plan.create.filter((b) => freshCreate.has(b.botId));
  for (const b of plan.create) {
    if (!freshCreate.has(b.botId) && !results.some((r) => r.botId === b.botId)) {
      results.push({ botId: b.botId, endpointId: b.endpointId, result: 'skipped', reason: 'no-longer-missing' });
    }
  }

  await storage.checkpoint({ phase: 'provisioning', registryRefresh: freshRefresh, skipped: ids(results) });

  // 5. One phrase and one `bot add` per bot. A failure stops the rest.
  let stopped = false;
  for (const ref of toCreate) {
    const bot = byId.get(ref.botId);
    const base = { botId: ref.botId, endpointId: ref.endpointId };
    if (stopped) { results.push({ ...base, result: 'skipped', reason: 'stopped-after-failure' }); continue; }
    const answer = await confirm(`Type ${botPhrase(ref.endpointId)} to create this bot: `);
    if (answer !== botPhrase(ref.endpointId)) { results.push({ ...base, result: 'skipped', reason: 'declined' }); continue; }
    const outcome = await runChild(spawn, execPath, botAddArgs(config, bot, cliPath), {
      env: childEnv.env,
      cwd: path.dirname(config.operatorIdentityPath),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    }, timeoutMs);
    if (outcome.kind === 'ok') results.push({ ...base, result: 'created' });
    else { results.push({ ...base, result: 'failed', reason: failReason(outcome) }); stopped = true; }
  }

  // 6. Check what was created against a new inspection, still under the lock.
  let finalRefresh = freshRefresh;
  const created = results.filter((r) => r.result === 'created');
  if (created.length) {
    let after = null;
    try { after = await inspect(); } catch { after = null; }
    finalRefresh = after?.registryRefresh ?? 'unverified';
    const healthy = new Set((after?.inspection === 'verified' ? after.bots : []).filter((b) => b.state === 'healthy').map((b) => b.botId));
    for (const r of created) r.verified = healthy.has(r.botId);
  }

  const failed = results.filter((r) => r.result === 'failed');
  const unverified = created.filter((r) => !r.verified);
  const declined = results.filter((r) => r.reason === 'declined' || r.reason === 'stopped-after-failure');
  const status = failed.length ? 'failed' : (unverified.length || declined.length) ? 'partial' : 'completed';
  await storage.checkpoint({
    phase: failed.length ? 'failed' : 'provisioned',
    registryRefresh: ['verified', 'unverified', 'unsupported'].includes(finalRefresh) ? finalRefresh : 'unverified',
    created: ids(created),
    skipped: ids(results.filter((r) => r.result === 'skipped')),
    failed: ids(failed),
    blockers: unverified.map((r) => `unverified-after-create:${r.botId}`),
  });
  return freezeResult({ status, registryRefresh: finalRefresh, bots: results });
}

export function renderApplyResult(result) {
  const lines = [`Mode: apply; status: ${safe(result.status)}`, `registry_refresh: ${safe(result.registryRefresh)}`];
  for (const bot of result.bots) {
    const extra = bot.result === 'created' ? (bot.verified ? 'verified' : 'not verified') : bot.reason ? safe(bot.reason) : '';
    lines.push(`${safe(bot.endpointId)}: ${safe(bot.result)}${extra ? ` (${extra})` : ''}`);
  }
  lines.push(`blockers: ${result.blockers.map(safe).join(', ') || 'none'}`);
  return lines.join('\n');
}
