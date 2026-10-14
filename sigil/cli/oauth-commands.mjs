import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { publishAdmin } from '../relay/v1/admin-notify.mjs';
import { createInvite, listInvites, revokeInvite } from '../relay/v1/oauth/invites.mjs';
import { outboundFetchOptions } from '../relay/v1/outbound-fetch.mjs';
import { loadIdentity } from './identity.mjs';
import { loadConfigFile, resolveConfig } from './config-resolver.mjs';

const DEFAULT_CLI_CONFIG = '.sigil/config.json';
const GITHUB_ISSUER = 'https://github.com';
const GITHUB_API = 'https://api.github.com';
const DAY_MS = 24 * 3600_000;
const SELF_TTL_MS = 10 * 60_000;
const ROLES = new Set(['member', 'room_manager']);
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const COMMON = { identity: { type: 'string' }, config: { type: 'string' }, 'database-url': { type: 'string' } };
export const CREATE_USAGE = 'usage: sigil relay invite create (--name <name> --room <id>:<member|room_manager> [--room ...] | --self --provider github --login <name> [--endpoint <id>] | --human <human_id> --provider github --login <name> [--endpoint <id>] [--room <id>:<role> ...]) --public-origin <https origin> [--identity path] [--config path] [--database-url url]';
export const LIST_USAGE = 'usage: sigil relay invite list [--database-url url]';
export const REVOKE_USAGE = 'usage: sigil relay invite revoke <invite_id> [--identity path] [--config path] [--database-url url]';
export const IDENTITY_REVOKE_USAGE = 'usage: sigil relay identity revoke --provider github (--login <name> | --subject <id>) [--identity path] [--config path] [--database-url url]';

function parseRooms(specs = []) {
  return specs.map((spec) => {
    const at = spec.lastIndexOf(':');
    if (at <= 0 || at === spec.length - 1) throw new Error(`--room expects <room_id>:<role>, got "${spec}"`);
    const role = spec.slice(at + 1);
    if (!ROLES.has(role)) throw new Error(`--room role must be member or room_manager, got "${role}"`);
    return { roomId: spec.slice(0, at), role };
  });
}

// Resolves a login to its numeric GitHub id. The operator never types a raw id
// for an invite; the id comes from the API and must echo the login back.
export async function resolveGitHubId(login, { fetchImpl = fetch, apiBase = GITHUB_API } = {}) {
  if (typeof login !== 'string' || !LOGIN_PATTERN.test(login)) throw new Error(`invalid GitHub login "${login}"`);
  let response;
  try {
    response = await fetchImpl(`${apiBase}/users/${encodeURIComponent(login)}`, {
      headers: { accept: 'application/json', 'user-agent': 'sigil-cli' }, ...outboundFetchOptions(),
    });
  } catch { throw new Error('GitHub user lookup failed: provider unreachable'); }
  if (response.status !== 200) throw new Error(`GitHub user lookup failed: HTTP ${response.status}`);
  let json;
  try { json = await response.json(); } catch { throw new Error('GitHub user lookup failed: invalid JSON'); }
  if (!Number.isSafeInteger(json?.id) || json.id <= 0) throw new Error('GitHub user lookup failed: no numeric id');
  if (typeof json.login !== 'string' || json.login.toLowerCase() !== login.toLowerCase()) throw new Error('GitHub user lookup failed: login mismatch');
  return String(json.id);
}

function requireGitHub(values, usage) {
  if (values.provider !== 'github') throw new Error(`${usage} (--provider github is required; github is the only provider)`);
}

function actorFromIdentity(values, usage, { required }) {
  const config = loadConfigFile(values.config ?? DEFAULT_CLI_CONFIG);
  const { identityPath } = resolveConfig({ flags: { identity: values.identity }, config });
  if (!identityPath) {
    if (required) throw new Error(`${usage} (or set SIGIL_IDENTITY / default_identity in .sigil/config.json)`);
    return null;
  }
  return loadIdentity(identityPath).owner_id;
}

async function withRepository(values, verb, fn) {
  const databaseUrl = values['database-url'] ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error(`sigil relay ${verb} requires --database-url (or SIGIL_DATABASE_URL)`);
  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try { return await fn(new PostgresRepository({ pool })); } finally { await pool.end(); }
}

function publicOrigin(values) {
  const raw = values['public-origin'] ?? process.env.SIGIL_PUBLIC_ORIGIN;
  let url;
  try { url = new URL(raw); } catch { url = null; }
  if (!url || url.protocol !== 'https:') throw new Error('sigil relay invite create requires --public-origin (or SIGIL_PUBLIC_ORIGIN) as an https: origin');
  return url.origin;
}

// The link is printed once; the token is not stored (only its SHA-256) and is
// never logged anywhere else.
export async function cmdInviteCreate(argv, { fetchImpl, apiBase, log = console.log, now = new Date() } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...COMMON, name: { type: 'string' }, room: { type: 'string', multiple: true }, self: { type: 'boolean' }, human: { type: 'string' },
      provider: { type: 'string' }, login: { type: 'string' }, endpoint: { type: 'string' }, 'public-origin': { type: 'string' },
    },
  });
  const rooms = parseRooms(values.room);
  const pinned = Boolean(values.self || values.human);
  if (values.self && values.human) throw new Error(`${CREATE_USAGE} (--self and --human are exclusive)`);
  if (values.self && rooms.length) throw new Error(`${CREATE_USAGE} (--self does not take --room)`);
  if (pinned && values.name) throw new Error(`${CREATE_USAGE} (--name is for an unpinned invite)`);
  if (!pinned && (values.provider || values.login || values.endpoint)) throw new Error(`${CREATE_USAGE} (--provider, --login and --endpoint need --self or --human)`);
  if (pinned) {
    requireGitHub(values, CREATE_USAGE);
    if (!values.login) throw new Error(`${CREATE_USAGE} (--login is required)`);
  } else if (!values.name) throw new Error(CREATE_USAGE);
  const origin = publicOrigin(values);
  const actorHumanId = actorFromIdentity(values, CREATE_USAGE, { required: true });
  const subject = pinned ? await resolveGitHubId(values.login, { fetchImpl, apiBase }) : null;

  const created = await withRepository(values, 'invite create', (repository) => repository.withTransaction(async (client) => {
    let target = null;
    if (pinned) {
      const humanId = values.self ? actorHumanId : values.human;
      let endpointId = values.endpoint;
      if (!endpointId) {
        const { rows } = await client.query(
          `SELECT endpoint_id FROM endpoints WHERE owner_id = $1 AND kind = 'human' AND status = 'active' ORDER BY created_at, endpoint_id`, [humanId]);
        if (rows.length === 0) throw new Error(`no active human endpoint for ${humanId}`);
        if (rows.length > 1) throw new Error(`${humanId} has ${rows.length} human endpoints; pass --endpoint <id> (${rows.map((r) => r.endpoint_id).join(', ')})`);
        endpointId = rows[0].endpoint_id;
      }
      target = { humanId, endpointId, issuer: GITHUB_ISSUER, subject };
    }
    return createInvite(client, {
      name: pinned ? values.login : values.name, createdByHumanId: actorHumanId, rooms, target, ttlMs: values.self ? SELF_TTL_MS : DAY_MS, now,
    });
  }));
  log(`invite_id: ${created.invite_id}`);
  log(`${origin}/invite#${created.token}`);
  return { invite_id: created.invite_id };
}

export async function cmdInviteList(argv, { log = console.log, now = new Date() } = {}) {
  const { values } = parseArgs({ args: argv, options: COMMON });
  const invites = await withRepository(values, 'invite list', (repository) => repository.withTransaction((client) => listInvites(client, { now })));
  if (!invites.length) log('(no invites)');
  for (const invite of invites) {
    const rooms = invite.rooms.map((r) => `${r.room_id}:${r.role}`).join(',') || '-';
    log([invite.invite_id, invite.state, invite.name, rooms, new Date(invite.expires_at).toISOString()].join('\t'));
  }
  return invites;
}

export async function cmdInviteRevoke(argv, { log = console.log, now = new Date() } = {}) {
  const { values, positionals } = parseArgs({ args: argv, options: COMMON, allowPositionals: true });
  if (positionals.length !== 1) throw new Error(REVOKE_USAGE);
  const actorHumanId = actorFromIdentity(values, REVOKE_USAGE, { required: true });
  const result = await withRepository(values, 'invite revoke', (repository) => repository.withTransaction((client) => revokeInvite(client, { inviteId: positionals[0], actorHumanId, now })));
  log(result.revoked ? `revoked ${positionals[0]}` : `${positionals[0]} not revoked (unknown, consumed, or already revoked)`);
  return result;
}

// One transaction: identity, its live sessions, the audit row, and the NOTIFY
// (delivered on commit) so a running relay closes sockets the identity holds.
export async function cmdIdentityRevoke(argv, { fetchImpl, apiBase, log = console.log, now = new Date() } = {}) {
  const { values } = parseArgs({ args: argv, options: { ...COMMON, provider: { type: 'string' }, login: { type: 'string' }, subject: { type: 'string' } } });
  requireGitHub(values, IDENTITY_REVOKE_USAGE);
  if (Boolean(values.login) === Boolean(values.subject)) throw new Error(`${IDENTITY_REVOKE_USAGE} (pass exactly one of --login or --subject)`);
  const actorHumanId = actorFromIdentity(values, IDENTITY_REVOKE_USAGE, { required: false });
  const subject = values.subject ?? await resolveGitHubId(values.login, { fetchImpl, apiBase });
  const stamp = now.toISOString();

  const result = await withRepository(values, 'identity revoke', (repository) => repository.withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE oidc_identities SET status = 'revoked' WHERE issuer = $1 AND subject = $2 AND verified_via = 'oauth' RETURNING human_id`,
      [GITHUB_ISSUER, subject]);
    if (!updated.rows[0]) throw new Error(`no OAuth-verified github identity with subject ${subject}`);
    const humanId = updated.rows[0].human_id;
    const sessions = await client.query(
      `UPDATE human_sessions SET revoked_at = $3 WHERE identity_issuer = $1 AND identity_subject = $2 AND revoked_at IS NULL AND expires_at > $3`,
      [GITHUB_ISSUER, subject, stamp]);
    await client.query(
      `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, object_type, object_id, outcome, created_at)
       VALUES ($1,'oidc_identity.revoked',$2,$3,'oidc_identity',$4,'success',$5)`,
      [`audit_${crypto.randomUUID()}`, `${GITHUB_ISSUER}|${subject}`, actorHumanId, subject, stamp]);
    await publishAdmin(client, { type: 'identity.revoked', human_id: humanId });
    return { human_id: humanId, sessions: sessions.rowCount };
  }));
  log(`revoked github identity ${subject} for ${result.human_id}; sessions revoked: ${result.sessions}`);
  return result;
}
