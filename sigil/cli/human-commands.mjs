import { parseArgs } from 'node:util';
import { loadWrapKey } from '../relay/v1/key-wrap.mjs';
import { provisionHumanTx } from '../relay/v1/provision-human.mjs';

const ADD_USAGE = 'usage: sigil human add --name <name> [--room <room_id>:<role> ...] [--database-url url] [--room-key-wrap-key env_var] [--identity path]';

export async function cmdHumanAdd(argv) {
  const args = parseArgs({
    args: argv,
    options: {
      name: { type: 'string' },
      room: { type: 'string', multiple: true },
      identity: { type: 'string' },
      'database-url': { type: 'string' },
      'room-key-wrap-key': { type: 'string' },
    },
  });
  const { values } = args;
  if (!values.name) throw new Error(ADD_USAGE);
  if (values.room?.length) {
    throw Object.assign(new Error('sigil human add --room is not implemented yet (NOT_IMPLEMENTED)'), { code: 'NOT_IMPLEMENTED' });
  }
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
      await client.query("SELECT pg_notify('sigil_admin', $1)", [JSON.stringify({
        type: 'human.provisioned',
        human_id: provisioned.human_id,
        endpoint_id: provisioned.endpoint_id,
        room_ids: [],
      })]);
      return provisioned;
    });
    console.log(`human_id: ${result.human_id}`);
    console.log(`endpoint_id: ${result.endpoint_id}`);
  } finally {
    await pool.end();
  }
}
