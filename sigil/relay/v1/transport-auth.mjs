import crypto from 'node:crypto';
import { isSocketLive } from './liveness.mjs';

function digest(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

// `registry`, when given, maps endpoint_id -> { owner_id, ... } (the same
// shape registry-store.mjs's toRegistryMap produces). A bearer token proves
// control of one endpoint, but every human-scoped route (OIDC identities,
// account links, directory invites/matches) needs the owner of that
// endpoint too -- this repo has no separate human-session credential, so
// the endpoint's registered owner_id stands in as its human_id. Agent
// endpoints (registry kind 'agent') are the exception: they keep owner_id
// but get no human_id, so every human-scoped route and capability-grant
// creation answers them 403 by design.
//
// With `repository` (Postgres mode), the registry is not consulted: owner,
// kind, and liveness come from repository.livenessSnapshot, cached per
// endpoint for `ttlMs`. clear()/clearAll() are driven by sigil_admin NOTIFY.
export function createBearerAuthenticator(tokenHashes, registry, { repository = null, ttlMs = 5000, now = Date.now } = {}) {
  const hashes = tokenHashes instanceof Map ? tokenHashes : new Map(Object.entries(tokenHashes ?? {}));
  const endpointFor = (request) => {
    const authorization = request.headers?.authorization;
    const protocols = request.headers?.['sec-websocket-protocol'];
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : typeof protocols === 'string' && protocols.split(',').map((item) => item.trim()).find((item) => item.startsWith('sigil-bearer.'))?.slice('sigil-bearer.'.length);
    if (!token) return null;
    return hashes.get(digest(token)) ?? null;
  };
  // human_id proves a human is calling; agent endpoints act for their owner
  // but are not the owner (rooms design: agents act under their own identity).
  const principalFor = (endpointId, owner_id, kind) => {
    if (!owner_id) return { endpoint_id: endpointId };
    const principal = { endpoint_id: endpointId, owner_id };
    return kind === 'human' ? { ...principal, human_id: owner_id } : principal;
  };

  if (!repository) {
    const authenticate = async (request) => {
      const endpointId = endpointFor(request);
      if (!endpointId) return null;
      const endpoint = registry?.get(endpointId);
      return principalFor(endpointId, endpoint?.owner_id, endpoint?.kind);
    };
    authenticate.clear = () => {};
    authenticate.clearAll = () => {};
    return authenticate;
  }

  // endpoint_id -> { principal, ownerId, expiresAt }; principal null is cached too.
  const cache = new Map();
  // Bumped by every clear, so a read that started before a clear is neither
  // served nor cached: it may have seen the pre-revocation row.
  let generation = 0;
  const MAX_ATTEMPTS = 3;
  const authenticate = async (request) => {
    const endpointId = endpointFor(request);
    if (!endpointId) return null;
    const hit = cache.get(endpointId);
    if (hit && hit.expiresAt > now()) return hit.principal;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const started = generation;
      let snapshot;
      try { snapshot = await repository.livenessSnapshot({ endpointId }); } catch { return null; }
      if (started !== generation) continue;
      const principal = isSocketLive(snapshot) ? principalFor(endpointId, snapshot.owner_id, snapshot.kind) : null;
      cache.set(endpointId, { principal, ownerId: snapshot?.owner_id ?? null, expiresAt: now() + ttlMs });
      return principal;
    }
    return null;
  };
  authenticate.clear = ({ humanId, endpointId } = {}) => {
    generation += 1;
    if (endpointId) cache.delete(endpointId);
    if (humanId) for (const [id, entry] of cache) if (entry.ownerId === humanId) cache.delete(id);
  };
  authenticate.clearAll = () => {
    generation += 1;
    cache.clear();
  };
  return authenticate;
}

export function hashBearerToken(token) {
  return digest(token);
}
