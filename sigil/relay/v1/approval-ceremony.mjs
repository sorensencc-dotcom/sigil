import crypto from 'node:crypto';

function readCbor(data, offset = 0) {
  if (offset >= data.length) throw new Error('CBOR read out of bounds');
  const first = data[offset++]; const major = first >> 5; let length = first & 31;
  if (length === 31 || length === 27) throw new Error('Unsupported CBOR length');
  if (length === 24) { if (offset + 1 > data.length) throw new Error('CBOR read out of bounds'); length = data[offset++]; } else if (length === 25) { if (offset + 2 > data.length) throw new Error('CBOR read out of bounds'); length = data.readUInt16BE(offset); offset += 2; } else if (length === 26) { if (offset + 4 > data.length) throw new Error('CBOR read out of bounds'); length = data.readUInt32BE(offset); offset += 4; }
  if ((major === 2 || major === 3) && offset + length > data.length) throw new Error('CBOR read out of bounds');
  if (major === 0) return { value: length, offset };
  if (major === 1) return { value: -1 - length, offset };
  if (major === 2) return { value: data.subarray(offset, offset + length), offset: offset + length };
  if (major === 3) return { value: data.subarray(offset, offset + length).toString('utf8'), offset: offset + length };
  if (major === 5) { const value = new Map(); for (let i = 0; i < length; i++) { const key = readCbor(data, offset); const item = readCbor(data, key.offset); value.set(key.value, item.value); offset = item.offset; } return { value, offset }; }
  throw new Error('Unsupported CBOR type');
}

export function parseAttestationObject(attestationObject) {
  try {
    const root = readCbor(Buffer.from(attestationObject, 'base64url')).value;
    if (!(root instanceof Map) || !['none', 'packed'].includes(root.get('fmt')) || !Buffer.isBuffer(root.get('authData'))) return null;
    const authData = root.get('authData');
    if (authData.length < 55 || (authData[32] & 0x40) === 0) return null;
    const credentialLength = authData.readUInt16BE(53);
    const credentialStart = 55; const credentialEnd = credentialStart + credentialLength;
    if (credentialLength < 1 || credentialEnd > authData.length) return null;
    const credentialId = authData.subarray(credentialStart, credentialEnd);
    const coseKey = readCbor(authData, credentialEnd).value;
    const decoded = coseKeyToPublicKey(coseKey);
    if (!decoded) return null;
    return { format: root.get('fmt'), credentialId, coseKey, ...decoded };
  } catch { return null; }
}

export function coseKeyToPublicKey(coseKey) {
  try {
    const map = coseKey instanceof Map ? coseKey : readCbor(Buffer.isBuffer(coseKey) || coseKey instanceof Uint8Array ? Buffer.from(coseKey) : Buffer.from(coseKey, 'base64url')).value;
    const kty = map.get(1); const alg = map.get(3);
    if (kty === 1 && alg === -8 && map.get(-1) === 6 && Buffer.isBuffer(map.get(-2))) {
      return { algorithm: 'EdDSA', publicKey: crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), map.get(-2)]), format: 'der', type: 'spki' }) };
    }
    if (kty === 2 && alg === -7 && map.get(-1) === 1 && Buffer.isBuffer(map.get(-2)) && Buffer.isBuffer(map.get(-3)) && map.get(-2).length === 32 && map.get(-3).length === 32) {
      const x = map.get(-2); const y = map.get(-3); const uncompressed = Buffer.concat([Buffer.from([4]), x, y]);
      return { algorithm: 'ES256', publicKey: crypto.createPublicKey({ key: Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), uncompressed]), format: 'der', type: 'spki' }) };
    }
  } catch { return null; }
  return null;
}

export function verifyWebAuthnSignature({ signedData, signature, credential } = {}) {
  if (!signedData || !signature || !credential?.publicKey) return false;
  try {
    return crypto.verify(null, Buffer.from(signedData, 'base64url'), credential.publicKey, Buffer.from(signature, 'base64url'));
  } catch { return false; }
}

export function verifyWebAuthnAssertion({ clientDataJSON, authenticatorData, signature, challenge, relayOrigin, rpId, credential } = {}) {
  if (!clientDataJSON || !authenticatorData || !signature || !challenge?.webauthnChallenge || !credential?.publicKey) return false;
  try {
    const clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8'));
    const authData = Buffer.from(authenticatorData, 'base64url');
    const rpHash = crypto.createHash('sha256').update(rpId).digest();
    if (clientData.type !== 'webauthn.get' || clientData.origin !== relayOrigin || clientData.challenge !== challenge.webauthnChallenge || authData.length < 37 || !crypto.timingSafeEqual(authData.subarray(0, 32), rpHash) || (authData[32] & 0x04) === 0) return false;
    const clientHash = crypto.createHash('sha256').update(Buffer.from(clientDataJSON, 'base64url')).digest();
    const algorithm = credential.algorithm === 'ES256' || credential.algorithm === -7 ? 'sha256' : null;
    if (!algorithm && credential.algorithm && credential.algorithm !== 'EdDSA' && credential.algorithm !== -8) return false;
    return crypto.verify(algorithm, Buffer.concat([authData, clientHash]), credential.publicKey, Buffer.from(signature, 'base64url'));
  } catch { return false; }
}

export function createApprovalChallenge({ relayOrigin, actionHash, endpointId, callbackUrl, ttlMs = 5 * 60 * 1000 } = {}) {
  const origin = new URL(relayOrigin);
  const callback = new URL(callbackUrl);
  if (origin.protocol !== 'https:') throw Object.assign(new Error('Approval origin must use HTTPS'), { code: 'APPROVAL_REQUIRED' });
  if (callback.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname)) {
    throw Object.assign(new Error('Approval callback must be localhost HTTP'), { code: 'APPROVAL_REQUIRED' });
  }
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('base64url');
  const webauthnChallenge = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const url = new URL('/approve', origin);
  url.searchParams.set('challenge', id); url.searchParams.set('cb', callbackUrl);
  return { id, token, webauthnChallenge, actionHash, endpointId, callbackUrl, expiresAt, approvalUrl: url.toString(), used: false };
}

export function consumeApprovalResult(challenge, result) {
  if (!challenge || challenge.used || Date.parse(challenge.expiresAt) <= Date.now()) throw Object.assign(new Error('Approval challenge expired or used'), { code: 'APPROVAL_EXPIRED' });
  if (!result?.token || result.token !== challenge.token || result.actionHash !== challenge.actionHash) throw Object.assign(new Error('Approval result binding failed'), { code: 'APPROVAL_REQUIRED' });
  challenge.used = true;
  return { verified: true, decisionToken: result.decisionToken };
}

export async function verifyWebAuthnApproval({ challenge, assertion, relayOrigin, rpId, credential, verifyAssertion, now = Date.now() } = {}) {
  if (!challenge || challenge.used || challenge.consuming || Date.parse(challenge.expiresAt) <= now) {
    throw Object.assign(new Error('Approval challenge expired or used'), { code: 'APPROVAL_EXPIRED' });
  }
  if (!assertion?.challenge || assertion.challenge !== challenge.id || assertion.actionHash !== challenge.actionHash ||
      (challenge.endpointId && assertion.endpointId !== challenge.endpointId)) {
    throw Object.assign(new Error('WebAuthn challenge binding failed'), { code: 'APPROVAL_REQUIRED' });
  }
  if (assertion.origin !== relayOrigin || assertion.rpId !== rpId || assertion.userVerified !== true) {
    throw Object.assign(new Error('WebAuthn assertion policy failed'), { code: 'APPROVAL_REQUIRED' });
  }
  if (!credential || assertion.credentialId !== credential.credentialId || credential.status !== 'active' || credential.humanStatus && credential.humanStatus !== 'active' || credential.type !== 'webauthn' ||
      (credential.validUntil && Date.parse(credential.validUntil) <= now)) {
    throw Object.assign(new Error('WebAuthn credential unavailable'), { code: 'APPROVAL_REQUIRED' });
  }
  if (typeof verifyAssertion !== 'function') throw Object.assign(new Error('WebAuthn verifier is not configured'), { code: 'APPROVAL_REQUIRED' });
  challenge.consuming = true;
  try {
    if (!(await verifyAssertion({ assertion, credential, challenge }))) {
      throw Object.assign(new Error('WebAuthn assertion verification failed'), { code: 'APPROVAL_REQUIRED' });
    }
    challenge.used = true;
  } catch (error) {
    challenge.consuming = false;
    throw error;
  }
  delete challenge.consuming;
  return { verified: true, actorId: credential.humanId, credentialId: credential.credentialId, actionHash: challenge.actionHash };
}
