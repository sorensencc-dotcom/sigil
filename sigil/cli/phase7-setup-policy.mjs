// Phase 7 owner-run setup: pure policy. No I/O, no DB, no network, no secrets.
// Config and plans carry references (env var names, paths, IDs), never values.
import path from 'node:path';
import { parseFederatedId } from '../relay/v1/federated-id.mjs';

// First group approved by Chris 2026-11-11. Endpoint names are PROPOSED pending
// his naming confirmation; Floor Warden's dispatcher role is not yet confirmed.
export const APPROVED_FIRST_GROUP = Object.freeze([
  { botId: '3028d8e4-f65c-4039-9bc0-862d1b003d5c', endpointId: 'ep_grok_bot@rewritelabs.io', displayName: 'Grok Bot · Elon', role: 'reply', roleConfirmed: true, namingStatus: 'proposed' },
  { botId: '1be4aab7-c288-41aa-8d55-ae358fb6f797', endpointId: 'ep_first_mate@rewritelabs.io', displayName: 'First Mate · Orchestrator', role: 'reply', roleConfirmed: true, namingStatus: 'proposed' },
  { botId: '8e21de41-8954-4a7c-a3fc-192cfbb210e2', endpointId: 'ep_floor_warden@rewritelabs.io', displayName: 'Floor Warden', role: 'dispatcher', roleConfirmed: false, namingStatus: 'proposed' },
].map((bot) => Object.freeze(bot)));

const ROLES = new Set(['reply', 'dispatcher']);
const CONFIG_FIELDS = new Set(['secretRoot', 'operatorIdentityPath', 'registryPath', 'dbLabel', 'databaseEnv', 'wrapKeyRef', 'relayDomain', 'routine', 'bots', 'replyOrigin', 'ports']);
const ROUTINE_FIELDS = new Set(['urlEnv', 'keyEnv', 'urlRef', 'keyRef', 'keyHeader']);
const BOT_FIELDS = new Set(['botId', 'endpointId', 'displayName', 'role', 'roleConfirmed', 'identityPath']);
const PATH_FIELDS = ['secretRoot', 'operatorIdentityPath', 'registryPath'];

const argsError = (message) => Object.assign(new Error(message), { code: 'INVALID_SETUP_ARGS' });
const configError = (message) => Object.assign(new Error(message), { code: 'INVALID_SETUP_CONFIG' });

// Errors name the offending flag only, never a value that may be a secret.
export function parseSetupArgs(argv) {
  const out = { apply: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--help') out.help = true;
    else if (arg === '--config') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw argsError('--config requires a path');
      out.configPath = value;
      i += 1;
    } else {
      const name = arg.startsWith('--') ? arg.split('=')[0] : 'positional argument';
      throw argsError(`unsupported ${name}; allowed: --config <path>, --apply, --help`);
    }
  }
  return out;
}

function unknownFields(obj, allowed, where) {
  for (const key of Object.keys(obj)) if (!allowed.has(key)) throw configError(`unknown field ${where}${key}`);
}

function isInside(child, root) {
  const p = /^[A-Za-z]:\\/.test(root) || /^[A-Za-z]:\\/.test(child) ? path.win32 : path.posix;
  const rel = p.relative(root.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

function validateEndpoint(endpointId, relayDomain) {
  if (typeof endpointId !== 'string' || endpointId.includes('/')) throw configError('endpointId must be <name>@<relay domain>');
  let parsed;
  try { parsed = parseFederatedId(endpointId); } catch { throw configError('endpointId must be <name>@<relay domain>'); }
  if (parsed.domain.toLowerCase() !== relayDomain.toLowerCase()) throw configError('endpointId domain must match relayDomain');
}

export function validateSetupConfig(raw, { repoRoot }) {
  if (!raw || typeof raw !== 'object') throw configError('config must be an object');
  unknownFields(raw, CONFIG_FIELDS, '');
  if (typeof raw.relayDomain !== 'string' || !raw.relayDomain) throw configError('relayDomain is required');
  for (const field of PATH_FIELDS) {
    if (typeof raw[field] !== 'string' || !raw[field]) throw configError(`${field} is required`);
    if (repoRoot && isInside(raw[field], repoRoot)) throw configError(`${field} must be outside the repository`);
  }
  if (!raw.routine || typeof raw.routine !== 'object') throw configError('routine is required');
  unknownFields(raw.routine, ROUTINE_FIELDS, 'routine.');
  if (!Array.isArray(raw.bots) || raw.bots.length === 0) throw configError('bots must be a non-empty list');
  const seen = new Set();
  const bots = raw.bots.map((bot, index) => {
    unknownFields(bot, BOT_FIELDS, `bots[${index}].`);
    if (typeof bot.botId !== 'string' || !bot.botId) throw configError(`bots[${index}].botId is required`);
    validateEndpoint(bot.endpointId, raw.relayDomain);
    if (bot.botId === bot.endpointId) throw configError(`bots[${index}] botId must differ from endpointId`);
    if (!ROLES.has(bot.role)) throw configError(`bots[${index}].role must be reply or dispatcher`);
    if (typeof bot.roleConfirmed !== 'boolean') throw configError(`bots[${index}].roleConfirmed must be boolean`);
    if (typeof bot.identityPath !== 'string' || (repoRoot && isInside(bot.identityPath, repoRoot))) throw configError(`bots[${index}].identityPath must be outside the repository`);
    for (const id of [bot.botId, bot.endpointId.toLowerCase()]) {
      if (seen.has(id)) throw configError(`bots[${index}] duplicates another bot`);
      seen.add(id);
    }
    return Object.freeze({ ...bot });
  });
  return Object.freeze({ ...raw, routine: Object.freeze({ ...raw.routine }), bots: Object.freeze(bots) });
}

// Literal state machine: unverified -> blocked; partial/conflict/disabled -> blocked;
// unconfirmed dispatcher -> blocked; healthy -> skip; missing -> create (only when
// inspection, schema and automatic registry refresh are all verified).
export function planSetup(snapshot, { apply = false } = {}) {
  const blockers = [...(snapshot.blockers ?? [])];
  if (snapshot.inspection !== 'verified') blockers.push('inspection-unverified');
  if (!snapshot.schemaReady) blockers.push('schema-not-ready');
  if (snapshot.registryRefresh !== 'verified') blockers.push(`registry-refresh-${snapshot.registryRefresh ?? 'unverified'}`);
  const globalOk = blockers.length === 0;
  const create = [];
  const skip = [];
  const botInputs = [];
  for (const bot of snapshot.bots) {
    const ref = Object.freeze({ botId: bot.botId, endpointId: bot.endpointId, role: bot.role });
    let state = bot.state;
    if (bot.state === 'healthy') skip.push(ref);
    else if (['partial', 'conflict', 'disabled'].includes(bot.state)) blockers.push(`bot-${bot.state}:${bot.botId}`);
    else if (bot.state === 'missing' && bot.role === 'dispatcher' && !bot.roleConfirmed) { blockers.push(`role-unconfirmed:${bot.botId}`); state = 'blocked'; }
    else if (bot.state === 'missing' && globalOk) create.push(ref);
    else if (bot.state !== 'missing') blockers.push(`bot-unknown-state:${bot.botId}`);
    botInputs.push(Object.freeze({ name: bot.botId, state }));
  }
  const inputs = [
    Object.freeze({ name: 'routine_url', state: snapshot.routine?.urlState ?? 'unverified' }),
    Object.freeze({ name: 'sender_key', state: snapshot.routine?.keyState ?? 'unverified' }),
    ...botInputs,
  ];
  const fourInputsReady = blockers.length === 0 && inputs.every((i) => i.state === 'present' || i.state === 'healthy');
  return Object.freeze({
    mode: apply ? 'apply' : 'dry-run',
    inputs: Object.freeze(inputs),
    create: Object.freeze(create),
    skip: Object.freeze(skip),
    blockers: Object.freeze(blockers),
    fourInputsReady,
    registryRefresh: snapshot.registryRefresh ?? 'unverified',
    smokeRun: false,
  });
}

const SAFE = /^[A-Za-z0-9_.@:\-]+$/;
const safe = (value) => (typeof value === 'string' && SAFE.test(value) ? value : '[redacted]');

export function renderSummary(plan) {
  const lines = [`Mode: ${plan.mode}; Phase 7 paused; active track: one-link enrollment`];
  for (const input of plan.inputs) lines.push(`${safe(input.name)}: ${safe(input.state)}`);
  lines.push(`registry_refresh: ${safe(plan.registryRefresh)}`);
  lines.push(`create: ${plan.create.map((b) => safe(b.endpointId)).join(', ') || 'none'}`);
  lines.push(`skip: ${plan.skip.map((b) => safe(b.endpointId)).join(', ') || 'none'}`);
  lines.push(`blockers: ${plan.blockers.map(safe).join(', ') || 'none'}`);
  lines.push(`Result: ${plan.fourInputsReady ? 'inputs structurally ready' : 'setup incomplete'}; live Grok smoke NOT RUN`);
  return lines.join('\n');
}

export function authorized({ apply, isTTY, entered, dbLabel }) {
  return apply === true && isTTY === true && typeof dbLabel === 'string' && dbLabel.length > 0
    && entered === `APPLY PHASE7 ${dbLabel}`;
}
