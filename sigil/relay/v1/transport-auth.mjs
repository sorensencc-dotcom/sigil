import crypto from 'node:crypto';

function digest(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createBearerAuthenticator(tokenHashes) {
  const hashes = tokenHashes instanceof Map ? tokenHashes : new Map(Object.entries(tokenHashes ?? {}));
  return (request) => {
    const authorization = request.headers?.authorization;
    const protocols = request.headers?.['sec-websocket-protocol'];
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : typeof protocols === 'string' && protocols.split(',').map((item) => item.trim()).find((item) => item.startsWith('sigil-bearer.'))?.slice('sigil-bearer.'.length);
    if (!token) return null;
    const endpointId = hashes.get(digest(token));
    return endpointId ? { endpoint_id: endpointId } : null;
  };
}

export function hashBearerToken(token) {
  return digest(token);
}
