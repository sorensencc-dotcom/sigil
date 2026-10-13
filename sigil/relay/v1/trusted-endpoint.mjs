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

// A registered-Map row in either shape (top-level key, or already a `keys` Map)
// as a trusted entry. Used only where a repository has no lookupTrustedEndpoint
// (Postgres-less test fakes and the legacy no-repository accept path).
export function entryFromMap(registered, endpointId) {
  const row = registered?.get?.(endpointId);
  if (!row) return null;
  return row.keys instanceof Map ? { ...row, kind: row.kind ?? 'human' } : entryFromRegistryRow(row);
}

// The single read of an endpoint's trust state. Postgres mode (and the memory
// repository) answer from the repository on the caller's client; the Map is
// read only when the repository cannot answer at all. `client ?? undefined`
// so a null client falls through to the repository's pool default.
export async function lookupTrustedEntry(repository, registered, endpointId, client) {
  if (typeof repository?.lookupTrustedEndpoint === 'function') return repository.lookupTrustedEndpoint(endpointId, client ?? undefined);
  return entryFromMap(registered, endpointId);
}

export function publicKeyFromDer(der) {
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}
