// sigil/cli/registry-seed.mjs
// Insert-only seed of the registry file into Postgres for `sigil relay up`.
// Postgres owns identity once a row exists: the file never raises a status and
// never rewrites owner, kind, or key. It may only lower status (revoke/suspend)
// and may only insert rows that are missing. Differences in owner_id, kind, or
// public key fail startup with REGISTRY_CONFLICT.
import crypto from 'node:crypto';

const STATUS_RANK = { active: 0, suspended: 1, revoked: 2 };

function spkiOf(pem) {
  return crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
}

export class RegistryConflictError extends Error {
  constructor(details) {
    const lines = details.map((d) => `${d.endpoint_id}: ${d.field} file=${d.file} postgres=${d.postgres}`);
    super(`REGISTRY_CONFLICT: registry file disagrees with Postgres (${lines.join('; ')}). Fix the file, or for a kind mismatch pass --reconcile-kind <endpoint_id>=<kind>.`);
    this.name = 'RegistryConflictError';
    this.code = 'REGISTRY_CONFLICT';
    this.details = details;
  }
}

export async function seedRegistry(pool, data, { reconcileKind = new Map() } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const conflicts = [];
    for (const ep of data.endpoints) {
      const fileKind = ep.kind ?? 'human';
      const fileStatus = ep.status in STATUS_RANK ? ep.status : 'active';
      await client.query(
        `INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW()) ON CONFLICT (human_id) DO NOTHING`,
        [ep.owner_id]);
      await client.query(`
        INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (endpoint_id) DO NOTHING
      `, [ep.endpoint_id, ep.owner_id, ep.kind ?? 'agent', fileKind, `install_${ep.endpoint_id}`, ep.endpoint_id, fileStatus]);

      const { rows: [pgRow] } = await client.query(
        'SELECT owner_id, kind, status FROM endpoints WHERE endpoint_id = $1', [ep.endpoint_id]);
      const { rows: keyRows } = await client.query(
        'SELECT key_id, public_key, status FROM endpoint_keys WHERE endpoint_id = $1', [ep.endpoint_id]);

      if (ep.public_key_pem && keyRows.length === 0) {
        await client.query(`
          INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
          VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())
          ON CONFLICT (key_id) DO NOTHING
        `, [ep.key_id, ep.endpoint_id, spkiOf(ep.public_key_pem)]);
      } else if (ep.public_key_pem) {
        const fileKey = spkiOf(ep.public_key_pem);
        const active = keyRows.find((k) => k.status === 'active');
        const known = keyRows.find((k) => k.key_id === ep.key_id);
        const compare = active ?? known;
        if (compare && !Buffer.from(compare.public_key).equals(fileKey)) {
          conflicts.push({ endpoint_id: ep.endpoint_id, field: 'public_key', file: fileKey.toString('hex'), postgres: Buffer.from(compare.public_key).toString('hex') });
        }
      }

      if (pgRow.owner_id !== ep.owner_id) {
        conflicts.push({ endpoint_id: ep.endpoint_id, field: 'owner_id', file: ep.owner_id, postgres: pgRow.owner_id });
      }
      if (pgRow.kind !== fileKind) {
        if (reconcileKind.get(ep.endpoint_id) === fileKind) {
          await client.query('UPDATE endpoints SET kind = $2 WHERE endpoint_id = $1', [ep.endpoint_id, fileKind]);
        } else {
          conflicts.push({ endpoint_id: ep.endpoint_id, field: 'kind', file: fileKind, postgres: pgRow.kind });
        }
      }
      if ((STATUS_RANK[fileStatus] ?? 0) > (STATUS_RANK[pgRow.status] ?? 0)) {
        await client.query('UPDATE endpoints SET status = $2 WHERE endpoint_id = $1', [ep.endpoint_id, fileStatus]);
      }
    }
    if (conflicts.length) {
      await client.query('ROLLBACK');
      throw new RegistryConflictError(conflicts);
    }
    await client.query('COMMIT');
  } catch (error) {
    if (!(error instanceof RegistryConflictError)) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
