import { parseArgs } from 'node:util';
import { loadWrapKey } from '../relay/v1/key-wrap.mjs';
import { provisionHumanTx, addHumanToRoomsTx } from '../relay/v1/provision-human.mjs';
import { publishAdmin } from '../relay/v1/admin-notify.mjs';
import { loadIdentity } from './identity.mjs';
import { loadConfigFile, resolveConfig } from './config-resolver.mjs';

const DEFAULT_CLI_CONFIG = '.sigil/config.json';
const ADD_USAGE = 'usage: sigil human add --name <name> [--room <room_id>:<member|room_manager> ...] [--identity path] [--config path] [--database-url url] [--room-key-wrap-key env_var]';
const ADD_TO_ROOM_USAGE = 'usage: sigil human add-to-room --human <human_id> --room <room_id>:<member|room_manager> [--room ...] [--identity path] [--config path] [--database-url url]';

function parseMemberships(specs) {
  return specs.map((spec) => {
    const at = spec.lastIndexOf(':');
    if (at <= 0 || at === spec.length - 1) throw new Error(`--room expects <room_id>:<role>, got "${spec}"`);
    return { roomId: spec.slice(0, at), role: spec.slice(at + 1) };
  });
}

function resolveActorHumanId(values, usage) {
  const config = loadConfigFile(values.config ?? DEFAULT_CLI_CONFIG);
  const { identityPath } = resolveConfig({ flags: { identity: values.identity }, config });
  if (!identityPath) throw new Error(`${usage} (or set SIGIL_IDENTITY / default_identity in .sigil/config.json)`);
  return loadIdentity(identityPath).owner_id;
}

export async function cmdHumanAdd(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: 'string' },
      room: { type: 'string', multiple: true },
      identity: { type: 'string' },
      config: { type: 'string' },
      'database-url': { type: 'string' },
      'room-key-wrap-key': { type: 'string' },
    },
  });
  if (!values.name) throw new Error(ADD_USAGE);
  const memberships = values.room?.length ? parseMemberships(values.room) : [];
  const actorHumanId = memberships.length ? resolveActorHumanId(values, ADD_USAGE) : null;
  const databaseUrl = values['database-url'] ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error('sigil human add requires --database-url (or SIGIL_DATABASE_URL)');
  const wrapKey = loadWrapKey(values['room-key-wrap-key']);

  const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
  await applyMigrations(databaseUrl);
  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const repository = new PostgresRepository({ pool });
    const result = await repository.withTransaction(async (client) => {
      const provisioned = await provisionHumanTx(client, { displayName: values.name, attributes: [{ kind: 'name', value: values.name, source: 'cli' }], wrapKey });
      const added = memberships.length
        ? await addHumanToRoomsTx(client, { endpointId: provisioned.endpoint_id, memberships, actorHumanId, repository })
        : { room_ids: [] };
      await publishAdmin(client, {
        type: 'human.provisioned',
        human_id: provisioned.human_id,
        endpoint_id: provisioned.endpoint_id,
        room_ids: added.room_ids,
      });
      return provisioned;
    });
    console.log(`human_id: ${result.human_id}`);
    console.log(`endpoint_id: ${result.endpoint_id}`);
  } finally {
    await pool.end();
  }
}

const SET_INVOKABLE_USAGE = 'usage: sigil agent set-invokable --room <room_id> --agent <endpoint_id> --mode owner|members [--identity path] [--config path] [--database-url url]';

// `sigil agent set-invokable`: only the agent endpoint's owner (the --identity
// operator) may change who invokes it; a room manager may not.
export async function cmdAgentSetInvokable(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      room: { type: 'string' },
      agent: { type: 'string' },
      mode: { type: 'string' },
      identity: { type: 'string' },
      config: { type: 'string' },
      'database-url': { type: 'string' },
    },
  });
  if (!values.room || !values.agent || !values.mode) throw new Error(SET_INVOKABLE_USAGE);
  if (values.mode !== 'owner' && values.mode !== 'members') throw new Error(`--mode must be owner or members, got "${values.mode}"`);
  const actorHumanId = resolveActorHumanId(values, SET_INVOKABLE_USAGE);
  const databaseUrl = values['database-url'] ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error('sigil agent set-invokable requires --database-url (or SIGIL_DATABASE_URL)');

  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const repository = new PostgresRepository({ pool });
    const member = await repository.withTransaction(async (client) => {
      const target = await repository.lookupRoomMember(values.room, values.agent, client);
      if (!target) throw Object.assign(new Error(`${values.agent} is not a member of ${values.room} (ROOM_MEMBER_NOT_FOUND)`), { code: 'ROOM_MEMBER_NOT_FOUND' });
      const { rows } = await client.query('SELECT kind FROM endpoints WHERE endpoint_id = $1', [values.agent]);
      if (rows[0]?.kind !== 'agent') throw Object.assign(new Error(`${values.agent} is not an agent endpoint (INVALID_REQUEST)`), { code: 'INVALID_REQUEST' });
      if (target.owner_id !== actorHumanId) throw Object.assign(new Error(`only the owner of ${values.agent} can change who may invoke it (ROUTE_NOT_AUTHORIZED)`), { code: 'ROUTE_NOT_AUTHORIZED' });
      const updated = await repository.setRoomMemberInvokableBy({ conversationId: values.room, endpointId: values.agent, invokableBy: values.mode }, client);
      await publishAdmin(client, { type: 'agent.invokable', room_ids: [values.room] });
      return updated;
    });
    console.log(`${member.endpoint_id} invokable_by: ${member.invokable_by}`);
  } finally {
    await pool.end();
  }
}

const SUSPEND_USAGE = 'usage: sigil human suspend|unsuspend <human_id> [--identity path] [--config path] [--database-url url]';

// The acting operator is recorded on the audit row when an identity resolves;
// suspension itself needs only database access.
function optionalActorHumanId(values) {
  const config = loadConfigFile(values.config ?? DEFAULT_CLI_CONFIG);
  const { identityPath } = resolveConfig({ flags: { identity: values.identity }, config });
  return identityPath ? loadIdentity(identityPath).owner_id : null;
}

// `sigil human suspend|unsuspend <human_id>`: one transaction that changes the
// human, its endpoints, and (suspend) its sessions and in-flight invocations,
// then notifies running relays on sigil_admin at commit.
async function runSuspension(argv, { method, type, verb }) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { identity: { type: 'string' }, config: { type: 'string' }, 'database-url': { type: 'string' } },
    allowPositionals: true,
  });
  const humanId = positionals[0];
  if (!humanId || positionals.length > 1) throw new Error(SUSPEND_USAGE);
  const actorHumanId = optionalActorHumanId(values);
  const databaseUrl = values['database-url'] ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error(`sigil human ${verb} requires --database-url (or SIGIL_DATABASE_URL)`);

  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const repository = new PostgresRepository({ pool });
    const result = await repository.withTransaction(async (client) => {
      const changed = await repository[method]({ humanId, actorHumanId }, client);
      await publishAdmin(client, { type, human_id: humanId });
      return changed;
    });
    console.log(`${humanId} ${verb}ed; endpoints: ${result.endpoint_ids.join(', ') || '(none)'}`);
    if (result.invocation_ids) console.log(`cancelled invocations: ${result.invocation_ids.length}`);
  } finally {
    await pool.end();
  }
}

export function cmdHumanSuspend(argv) {
  return runSuspension(argv, { method: 'suspendHuman', type: 'human.suspended', verb: 'suspend' });
}

export function cmdHumanUnsuspend(argv) {
  return runSuspension(argv, { method: 'unsuspendHuman', type: 'human.unsuspended', verb: 'unsuspend' });
}

export async function cmdHumanAddToRoom(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      human: { type: 'string' },
      room: { type: 'string', multiple: true },
      identity: { type: 'string' },
      config: { type: 'string' },
      'database-url': { type: 'string' },
    },
  });
  if (!values.human || !values.room?.length) throw new Error(ADD_TO_ROOM_USAGE);
  const memberships = parseMemberships(values.room);
  const actorHumanId = resolveActorHumanId(values, ADD_TO_ROOM_USAGE);
  const databaseUrl = values['database-url'] ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error('sigil human add-to-room requires --database-url (or SIGIL_DATABASE_URL)');

  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const repository = new PostgresRepository({ pool });
    const result = await repository.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT endpoint_id FROM endpoints WHERE owner_id = $1 AND kind = 'human' AND status = 'active' ORDER BY created_at, endpoint_id LIMIT 1`,
        [values.human]);
      if (!rows[0]) throw Object.assign(new Error(`no active human endpoint for ${values.human} (HUMAN_NOT_FOUND)`), { code: 'HUMAN_NOT_FOUND' });
      const added = await addHumanToRoomsTx(client, { endpointId: rows[0].endpoint_id, memberships, actorHumanId, repository });
      await publishAdmin(client, { type: 'room.members', room_ids: added.room_ids });
      return added;
    });
    console.log(`rooms: ${result.room_ids.join(', ')}`);
  } finally {
    await pool.end();
  }
}
