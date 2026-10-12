import crypto from 'node:crypto';

export function keyVerifies(key, now = new Date()) {
  if (!key) return false;
  const t = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(t)) return false;
  const from = key.valid_from ? Date.parse(key.valid_from) : -Infinity;
  const until = key.valid_until ? Date.parse(key.valid_until) : null;
  if (key.status === 'active') return t >= from && (until === null || t < until);
  if (key.status === 'retiring') return until !== null && t >= from && t < until;
  return false;
}

// Memory mode: registry.json rows carry one top-level key. Normalize to the
// Postgres entry shape so validateEnvelope has a single code path.
export function entryFromRegistryRow(row) {
  if (!row) return null;
  return {
    endpoint_id: row.endpoint_id, owner_id: row.owner_id, status: row.status ?? 'active',
    kind: row.kind ?? 'human',
    keys: new Map([[row.key_id, { key_id: row.key_id, public_key: row.public_key, status: 'active', valid_from: new Date(0).toISOString(), valid_until: null }]]),
  };
}

export function publicKeyFromDer(der) {
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}
