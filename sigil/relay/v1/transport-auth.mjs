import crypto from 'node:crypto';

function digest(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createBearerAuthenticator(tokenHashes) {
  const hashes = tokenHashes instanceof Map ? tokenHashes : new Map(Object.entries(tokenHashes ?? {}));
  return (request) => {
    const value = request.headers?.authorization ?? request.headers?.['sec-websocket-protocol'];
    const token = typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : null;
    if (!token) return null;
    const endpointId = hashes.get(digest(token));
    return endpointId ? { endpoint_id: endpointId } : null;
  };
}

export function hashBearerToken(token) {
  return digest(token);
}
