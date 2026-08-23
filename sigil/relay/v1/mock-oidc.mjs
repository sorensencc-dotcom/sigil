import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/mock-oidc-keys.json', import.meta.url));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const FIXTURE_ISSUER = fixture.issuer;
const privateKey = crypto.createPrivateKey({ key: fixture.privateJwk, format: 'jwk' });
const publicKey = crypto.createPublicKey({ key: fixture.publicJwk, format: 'jwk' });

const REQUIRED_CLAIMS = ['iss', 'sub', 'email', 'email_verified', 'iat', 'exp', 'jti'];
const CLOCK_SKEW_SECONDS = 30;

function b64url(buffer) {
  return buffer.toString('base64url');
}

function invalidToken(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ID_TOKEN' });
}

// Test/dev-only signer. Never reachable over HTTP -- exported for tests and
// dev tooling to construct a mock ID token, not called from any route.
export function signMockIdToken({ subject, email, issuer = FIXTURE_ISSUER, now = new Date(), ttlSeconds = 300 } = {}) {
  if (ttlSeconds <= 0) throw new Error('ttlSeconds must be positive');
  const iat = Math.floor((now instanceof Date ? now : new Date(now)).getTime() / 1000);
  const exp = iat + ttlSeconds;
  const header = { alg: 'ES256', typ: 'JWT' };
  const payload = { iss: issuer, sub: subject, email, email_verified: true, iat, exp, jti: crypto.randomUUID() };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}

// Verifies against the same committed fixture keypair the signer above
// uses -- no JWKS fetch, entirely local. `now` is injectable so tests can
// control time without real delays (mirrors the rest of http-server.mjs's
// `now: () => new Date()` convention).
export function verifyMockIdToken(token, { now = () => new Date() } = {}) {
  if (typeof token !== 'string') throw invalidToken('ID token must be a string');
  const segments = token.split('.');
  if (segments.length !== 3) throw invalidToken('Malformed compact JWS');
  const [headerSegment, payloadSegment, signatureSegment] = segments;

  let header;
  try { header = JSON.parse(Buffer.from(headerSegment, 'base64url').toString()); }
  catch { throw invalidToken('Malformed JWS header'); }
  // Alg-confusion / none-alg hard rejection -- checked before the signature
  // is ever touched, per spec's header/algorithm-hardening requirement.
  if (header.alg !== 'ES256') throw invalidToken(`Unsupported or missing alg: ${header.alg}`);

  let signature;
  try { signature = Buffer.from(signatureSegment, 'base64url'); }
  catch { throw invalidToken('Malformed JWS signature'); }
  const signingInput = `${headerSegment}.${payloadSegment}`;
  let signatureValid;
  try { signatureValid = crypto.verify('sha256', Buffer.from(signingInput), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature); }
  catch { throw invalidToken('Signature verification failed'); }
  if (!signatureValid) throw invalidToken('Signature verification failed');

  let payload;
  try { payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString()); }
  catch { throw invalidToken('Malformed JWS payload'); }

  for (const claim of REQUIRED_CLAIMS) {
    if (!(claim in payload) || payload[claim] === null || payload[claim] === undefined) {
      throw invalidToken(`Missing required claim: ${claim}`);
    }
  }
  if (payload.email_verified !== true) throw invalidToken('email_verified must be true');

  const nowSeconds = Math.floor((typeof now === 'function' ? now() : now).getTime() / 1000);
  if (nowSeconds > payload.exp + CLOCK_SKEW_SECONDS) throw invalidToken('ID token has expired');
  if (nowSeconds < payload.iat - CLOCK_SKEW_SECONDS) throw invalidToken('ID token is not yet valid');

  return { issuer: payload.iss, subject: payload.sub, email: payload.email, jti: payload.jti };
}

export { FIXTURE_ISSUER };
