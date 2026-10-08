import crypto from 'node:crypto';

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
    const endpoint = registry?.get(endpointId);
    if (!endpoint?.owner_id) return { endpoint_id: endpointId };
    // human_id proves a human is calling; agent endpoints act for their owner
    // but are not the owner (rooms design: agents act under their own identity).
    return endpoint.kind === 'agent'
      ? { endpoint_id: endpointId, owner_id: endpoint.owner_id }
      : { endpoint_id: endpointId, owner_id: endpoint.owner_id, human_id: endpoint.owner_id };
  };
}

export function hashBearerToken(token) {
  return digest(token);
}
