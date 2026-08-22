import crypto from 'node:crypto';

function digest(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

// `registry`, when given, maps endpoint_id -> { owner_id, ... } (the same
// shape registry-store.mjs's toRegistryMap produces). A bearer token proves
// control of one endpoint, but every human-scoped route (OIDC identities,
// account links, directory invites/matches) needs the owner of that
// endpoint too -- this repo has no separate human-session credential, so
// the endpoint's registered owner_id stands in as its human_id.
export function createBearerAuthenticator(tokenHashes, registry) {
  const hashes = tokenHashes instanceof Map ? tokenHashes : new Map(Object.entries(tokenHashes ?? {}));
  return (request) => {
    const authorization = request.headers?.authorization;
    const protocols = request.headers?.['sec-websocket-protocol'];
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : typeof protocols === 'string' && protocols.split(',').map((item) => item.trim()).find((item) => item.startsWith('sigil-bearer.'))?.slice('sigil-bearer.'.length);
    if (!token) return null;
    const endpointId = hashes.get(digest(token));
    if (!endpointId) return null;
    const ownerId = registry?.get(endpointId)?.owner_id;
    return ownerId ? { endpoint_id: endpointId, owner_id: ownerId, human_id: ownerId } : { endpoint_id: endpointId };
  };
}

export function hashBearerToken(token) {
  return digest(token);
}
