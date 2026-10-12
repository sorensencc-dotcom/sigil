import { parseArgs } from 'node:util';
import { loadWrapKey } from '../relay/v1/key-wrap.mjs';
import { provisionHumanTx, addHumanToRoomsTx } from '../relay/v1/provision-human.mjs';
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

const publishAdmin = (client, payload) => client.query("SELECT pg_notify('sigil_admin', $1)", [JSON.stringify(payload)]);

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
