import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadWrapKey, wrapPrivateKey } from '../relay/v1/key-wrap.mjs';
import { loadIdentity } from './identity.mjs';
import { addEndpointToRegistry } from './registry-store.mjs';
import { loadConfigFile, resolveConfig } from './config-resolver.mjs';

const DEFAULT_CLI_CONFIG = '.sigil/config.json';
const ADD_USAGE = 'usage: sigil bot add --bot-id <id> --endpoint <endpoint_id> --name <display name> [--identity path] [--config path] [--out path] [--registry path] [--database-url url] [--room-bot-key-wrap-key env_var]';
const DISABLE_USAGE = 'usage: sigil bot disable --bot-id <id> [--database-url url]';

function operatorOwnerId(values) {
  const config = loadConfigFile(values.config ?? DEFAULT_CLI_CONFIG);
  const { identityPath } = resolveConfig({ flags: { identity: values.identity }, config });
  if (!identityPath) throw new Error(`${ADD_USAGE} (or set SIGIL_IDENTITY / default_identity in .sigil/config.json)`);
  return loadIdentity(identityPath).owner_id;
}

async function withRepository(databaseUrl, fn) {
  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    return await fn(new PostgresRepository({ pool }));
  } finally {
    await pool.end();
  }
}

// `sigil bot add`: one transaction creates the agent endpoint, its active key,
// the relay-held wrapped signing key, and the roster row. The private key lives
// only in memory; the identity file holds a relay token and no private key,
// plus bot_id, which `agent run --room-bridge floor-warden` reads.
// The file is written last inside the transaction, so a failure rolls back the
// database and removes the file.
export async function cmdBotAdd(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'bot-id': { type: 'string' },
      endpoint: { type: 'string' },
      name: { type: 'string' },
      identity: { type: 'string' },
      config: { type: 'string' },
      out: { type: 'string' },
      registry: { type: 'string' },
      'database-url': { type: 'string' },
      'room-bot-key-wrap-key': { type: 'string' },
    },
  });
  const botId = values['bot-id'];
  const endpointId = values.endpoint;
  if (!botId || !endpointId || !values.name) throw new Error(ADD_USAGE);
  const ownerId = operatorOwnerId(values);
  const databaseUrl = values['database-url'] ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error('sigil bot add requires --database-url (or SIGIL_DATABASE_URL)');
  const wrapKey = loadWrapKey(values['room-bot-key-wrap-key']);
  const outPath = path.resolve(values.out ?? path.join('.sigil', `${endpointId}.json`));
  const registryPath = path.resolve(values.registry ?? path.join('.sigil', 'registry.json'));
  if (fs.existsSync(outPath)) throw new Error(`identity file ${outPath} already exists; choose another --out`);

  const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
  await applyMigrations(databaseUrl);

  const keyId = `key_${crypto.randomBytes(16).toString('hex')}`;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const relayToken = crypto.randomBytes(24).toString('base64url');
  const now = new Date();
  const ts = now.toISOString();
  // Snapshot so a failed add restores the registry exactly (null = file did not exist).
  const registrySnapshot = fs.existsSync(registryPath) ? fs.readFileSync(registryPath) : null;
  let identityWritten = false;
  let registryTouched = false;
  try {
    await withRepository(databaseUrl, (repository) => repository.withTransaction(async (client) => {
      try {
        await client.query(
          `INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at)
           VALUES ($1,$2,'agent','agent',$3,$4,'active',$5)`,
          [endpointId, ownerId, `install_${endpointId}`, values.name, ts],
        );
      } catch (error) {
        if (error.code === '23505') throw new Error(`endpoint ${endpointId} already exists`);
        if (error.code === '23503') throw new Error(`operator owner ${ownerId} is not a provisioned human in this database`);
        throw error;
      }
      await client.query(
        `INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ($1,$2,'Ed25519',$3,'active',$4)`,
        [keyId, endpointId, publicKey.export({ type: 'spki', format: 'der' }), ts],
      );
      await repository.insertBotSigningKey({ keyId, wrapped: wrapPrivateKey({ wrapKey, endpointId, keyId, privateKey }), now }, client);
      try {
        await repository.insertFloorWardenBot({ bot_id: botId, endpoint_id: endpointId, display_name: values.name, status: 'active', created_at: now }, client);
      } catch (error) {
        if (error.code === 'BOT_EXISTS') throw new Error(`Floor Warden bot ${botId} or endpoint ${endpointId} already exists`);
        throw error;
      }
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
      try {
        // mode 0600 is advisory: NTFS does not enforce POSIX modes, so the token file is only as private as its directory.
        fs.writeFileSync(outPath, JSON.stringify({
          owner_id: ownerId,
          endpoint_id: endpointId,
          key_id: keyId,
          kind: 'agent',
          status: 'active',
          public_key_pem: publicKeyPem,
          relay_token: relayToken,
          receive_only: true,
          bot_id: botId,
        }, null, 2), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        // EEXIST means the file is someone else's; any other failure may leave a partial token behind.
        if (error.code !== 'EEXIST') fs.rmSync(outPath, { force: true });
        throw error;
      }
      identityWritten = true;
      // The relay builds its bearer-token hashes from this registry file at startup.
      registryTouched = true;
      addEndpointToRegistry(registryPath, { owner_id: ownerId, endpoint_id: endpointId, key_id: keyId, kind: 'agent', public_key_pem: publicKeyPem, relay_token: relayToken });
    }));
  } catch (error) {
    if (identityWritten) fs.rmSync(outPath, { force: true });
    if (registryTouched) {
      if (registrySnapshot === null) fs.rmSync(registryPath, { force: true });
      else fs.writeFileSync(registryPath, registrySnapshot);
    }
    throw error;
  }
  console.log(`bot_id: ${botId}`);
  console.log(`endpoint_id: ${endpointId}`);
  console.log(`identity: ${outPath}`);
  console.log(`registry: ${registryPath}`);
  console.log('restart relay after `bot add` so it loads the new token');
}

// `sigil bot disable`: idempotent; the reply route then answers BOT_NOT_ON_ROSTER.
export async function cmdBotDisable(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { 'bot-id': { type: 'string' }, 'database-url': { type: 'string' } },
  });
  const botId = values['bot-id'];
  if (!botId) throw new Error(DISABLE_USAGE);
  const databaseUrl = values['database-url'] ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error('sigil bot disable requires --database-url (or SIGIL_DATABASE_URL)');
  await withRepository(databaseUrl, (repository) => repository.withTransaction(async (client) => {
    const bot = await repository.lookupFloorWardenBot(botId, client);
    if (!bot) throw new Error(`Floor Warden bot ${botId} not found`);
    await client.query(`UPDATE floor_warden_bots SET status = 'disabled' WHERE bot_id = $1`, [botId]);
  }));
  console.log(`bot_id: ${botId}`);
  console.log('status: disabled');
}
