import crypto from 'node:crypto';

const MIN_LENGTH = 32;
const digest = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest();

function read(env, name) {
  const value = env?.[name];
  if (typeof value !== 'string' || value === '') {
    throw Object.assign(new Error(`Floor Warden reply token environment variable ${name} is not set`), { code: 'FLOOR_WARDEN_TOKEN_UNSET' });
  }
  if (value.length < MIN_LENGTH) {
    throw Object.assign(new Error(`Floor Warden reply token in ${name} must be at least ${MIN_LENGTH} characters`), { code: 'FLOOR_WARDEN_TOKEN_WEAK' });
  }
  return digest(value);
}

// Loads the reply token (and an optional rotation token) from the named
// environment variables. Only SHA-256 digests are kept, inside the closure.
export function loadReplyTokens(env, name, nextName) {
  const digests = [read(env, name)];
  if (nextName) digests.push(read(env, nextName));
  const matches = (candidate) => {
    if (typeof candidate !== 'string' || candidate === '') return false;
    const candidateDigest = digest(candidate);
    let ok = false;
    for (const known of digests) ok = crypto.timingSafeEqual(known, candidateDigest) || ok;
    return ok;
  };
  return Object.freeze({ matches, count: digests.length });
}
