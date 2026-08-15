import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeApprovalResult, coseKeyToPublicKey, createApprovalChallenge, parseAttestationObject, verifyPackedAttestation, verifyWebAuthnApproval, verifyWebAuthnSignature } from './approval-ceremony.mjs';
import crypto from 'node:crypto';

function cborMap(entries) {
  const parts = [Buffer.from([0xa0 + entries.length])];
  for (const [key, value] of entries) {
    parts.push(typeof key === 'string' ? Buffer.concat([Buffer.from([0x60 + key.length]), Buffer.from(key)]) : cborInt(key));
    parts.push(value);
  }
  return Buffer.concat(parts);
}

function cborInt(value) {
  if (value >= 0 && value < 24) return Buffer.from([value]);
  if (value < 0 && -1 - value < 24) return Buffer.from([0x20 + (-1 - value)]);
  throw new Error('test encoder only supports compact integers');
}

function cborText(value) { const bytes = Buffer.from(value); return Buffer.concat([Buffer.from([0x60 + bytes.length]), bytes]); }
function cborBytes(value) { return Buffer.concat([Buffer.from([0x58, value.length]), value]); }

test('approval URL uses relay origin and binds challenge to action', () => {
  const challenge = createApprovalChallenge({ relayOrigin: 'https://relay.example', actionHash: 'sha256:abc', endpointId: 'ep_codex', callbackUrl: 'http://127.0.0.1:4567/callback' });
  assert.equal(new URL(challenge.approvalUrl).origin, 'https://relay.example');
  assert.equal(new URL(challenge.approvalUrl).pathname, '/approve');
  assert.equal(new URL(challenge.approvalUrl).searchParams.get('cb'), challenge.callbackUrl);
});

test('approval challenge requires HTTPS relay and localhost callback', () => {
  assert.throws(() => createApprovalChallenge({ relayOrigin: 'http://relay.example', actionHash: 'sha256:abc', callbackUrl: 'http://127.0.0.1/cb' }), { code: 'APPROVAL_REQUIRED' });
  assert.throws(() => createApprovalChallenge({ relayOrigin: 'https://relay.example', actionHash: 'sha256:abc', callbackUrl: 'http://evil.example/cb' }), { code: 'APPROVAL_REQUIRED' });
});

test('approval result is single-use and action-bound', () => {
  const challenge = createApprovalChallenge({ relayOrigin: 'https://relay.example', actionHash: 'sha256:abc', callbackUrl: 'http://127.0.0.1/cb' });
  assert.deepEqual(consumeApprovalResult(challenge, { token: challenge.token, actionHash: 'sha256:abc', decisionToken: 'decision_1' }), { verified: true, decisionToken: 'decision_1' });
  assert.throws(() => consumeApprovalResult(challenge, { token: challenge.token, actionHash: 'sha256:abc' }), { code: 'APPROVAL_EXPIRED' });
});

function validAssertion(challenge, overrides = {}) {
  return { challenge: challenge.id, actionHash: challenge.actionHash, credentialId: 'cred_1', origin: 'https://relay.example', rpId: 'relay.example', userVerified: true, ...overrides };
}

function activeCredential(overrides = {}) {
  return { credentialId: 'cred_1', humanId: 'usr_1', type: 'webauthn', status: 'active', ...overrides };
}

test('WebAuthn approval enforces relay binding, user verification, and credential status', async () => {
  const challenge = createApprovalChallenge({ relayOrigin: 'https://relay.example', actionHash: 'sha256:abc', callbackUrl: 'http://127.0.0.1/cb' });
  const verifyAssertion = async ({ assertion, credential }) => assertion.credentialId === credential.credentialId;
  const assertion = validAssertion(challenge, { credentialId: 'cred_1' });
  assert.deepEqual(await verifyWebAuthnApproval({ challenge, assertion, relayOrigin: 'https://relay.example', rpId: 'relay.example', credential: activeCredential(), verifyAssertion }), {
    verified: true, actorId: 'usr_1', credentialId: 'cred_1', actionHash: 'sha256:abc'
  });
});

test('WebAuthn approval rejects forged binding, wrong origin, missing UV, and revoked credentials', async () => {
  const cases = [
    [{ actionHash: 'sha256:other' }, 'APPROVAL_REQUIRED'],
    [{ origin: 'https://evil.example' }, 'APPROVAL_REQUIRED'],
    [{ userVerified: false }, 'APPROVAL_REQUIRED']
  ];
  for (const [overrides, code] of cases) {
    const challenge = createApprovalChallenge({ relayOrigin: 'https://relay.example', actionHash: 'sha256:abc', callbackUrl: 'http://127.0.0.1/cb' });
    await assert.rejects(() => verifyWebAuthnApproval({ challenge, assertion: validAssertion(challenge, overrides), relayOrigin: 'https://relay.example', rpId: 'relay.example', credential: activeCredential(), verifyAssertion: async () => true }), { code });
  }
  const endpointChallenge = createApprovalChallenge({ relayOrigin: 'https://relay.example', actionHash: 'sha256:abc', endpointId: 'ep_codex', callbackUrl: 'http://127.0.0.1/cb' });
  await assert.rejects(() => verifyWebAuthnApproval({ challenge: endpointChallenge, assertion: validAssertion(endpointChallenge, { endpointId: 'ep_other' }), relayOrigin: 'https://relay.example', rpId: 'relay.example', credential: activeCredential(), verifyAssertion: async () => true }), { code: 'APPROVAL_REQUIRED' });
  const challenge = createApprovalChallenge({ relayOrigin: 'https://relay.example', actionHash: 'sha256:abc', callbackUrl: 'http://127.0.0.1/cb' });
  await assert.rejects(() => verifyWebAuthnApproval({ challenge, assertion: validAssertion(challenge), relayOrigin: 'https://relay.example', rpId: 'relay.example', credential: activeCredential({ status: 'revoked' }), verifyAssertion: async () => true }), { code: 'APPROVAL_REQUIRED' });
});

test('WebAuthn approval rejects credentials whose human principal is inactive', async () => {
  const challenge = createApprovalChallenge({ relayOrigin: 'https://relay.example', actionHash: 'sha256:abc', endpointId: 'ep_codex', callbackUrl: 'http://127.0.0.1:4567/callback' });
  await assert.rejects(() => verifyWebAuthnApproval({ challenge, assertion: validAssertion(challenge), relayOrigin: 'https://relay.example', rpId: 'relay.example', credential: activeCredential({ humanStatus: 'revoked' }), verifyAssertion: async () => true }), { code: 'APPROVAL_REQUIRED' });
});

test('verified WebAuthn approval is single-use and rejects expired challenges', async () => {
  const challenge = createApprovalChallenge({ relayOrigin: 'https://relay.example', actionHash: 'sha256:abc', callbackUrl: 'http://127.0.0.1/cb' });
  const args = { challenge, assertion: validAssertion(challenge), relayOrigin: 'https://relay.example', rpId: 'relay.example', credential: activeCredential(), verifyAssertion: async () => true };
  await verifyWebAuthnApproval(args);
  await assert.rejects(() => verifyWebAuthnApproval(args), { code: 'APPROVAL_EXPIRED' });
});

test('WebAuthn approval rejects missing verifier, mismatched credential, and concurrent consumption', async () => {
  const challenge = createApprovalChallenge({ relayOrigin: 'https://relay.example', actionHash: 'sha256:abc', callbackUrl: 'http://127.0.0.1/cb' });
  const base = { challenge, assertion: validAssertion(challenge, { credentialId: 'cred_other' }), relayOrigin: 'https://relay.example', rpId: 'relay.example', credential: activeCredential(), verifyAssertion: async () => true };
  await assert.rejects(() => verifyWebAuthnApproval(base), { code: 'APPROVAL_REQUIRED' });
  const concurrentChallenge = createApprovalChallenge({ relayOrigin: 'https://relay.example', actionHash: 'sha256:abc', callbackUrl: 'http://127.0.0.1/cb' });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const args = { challenge: concurrentChallenge, assertion: validAssertion(concurrentChallenge, { credentialId: 'cred_1' }), relayOrigin: 'https://relay.example', rpId: 'relay.example', credential: activeCredential(), verifyAssertion: async () => pending };
  const first = verifyWebAuthnApproval(args);
  await assert.rejects(() => verifyWebAuthnApproval(args), { code: 'APPROVAL_EXPIRED' });
  release(true); await first;
  const noVerifier = createApprovalChallenge({ relayOrigin: 'https://relay.example', actionHash: 'sha256:abc', callbackUrl: 'http://127.0.0.1/cb' });
  await assert.rejects(() => verifyWebAuthnApproval({ ...args, challenge: noVerifier, assertion: validAssertion(noVerifier, { credentialId: 'cred_1' }), verifyAssertion: undefined }), { code: 'APPROVAL_REQUIRED' });
});

test('WebAuthn signature adapter verifies registered public key and rejects forged material', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signedData = Buffer.from('authenticator-data-and-client-data-hash').toString('base64url');
  const signature = crypto.sign(null, Buffer.from(signedData, 'base64url'), privateKey).toString('base64url');
  assert.equal(verifyWebAuthnSignature({ signedData, signature, credential: { publicKey } }), true);
  assert.equal(verifyWebAuthnSignature({ signedData: Buffer.from('forged').toString('base64url'), signature, credential: { publicKey } }), false);
  assert.equal(verifyWebAuthnSignature({ signedData, signature: 'not-a-signature', credential: { publicKey } }), false);
});

test('COSE_Key decoder produces usable Ed25519 and ES256 public keys', () => {
  const ed = crypto.generateKeyPairSync('ed25519');
  const edRaw = ed.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const edKey = new Map([[1, 1], [3, -8], [-1, 6], [-2, edRaw]]);
  const decodedEd = coseKeyToPublicKey(edKey);
  assert.equal(decodedEd.algorithm, 'EdDSA');
  assert.equal(crypto.verify(null, Buffer.from('x'), decodedEd.publicKey, crypto.sign(null, Buffer.from('x'), ed.privateKey)), true);
  const encodedEd = cborMap([[1, cborInt(1)], [3, cborInt(-8)], [-1, cborInt(6)], [-2, Buffer.concat([Buffer.from([0x58, edRaw.length]), edRaw])]]).toString('base64url');
  const decodedEdBytes = coseKeyToPublicKey(encodedEd);
  assert.equal(decodedEdBytes.algorithm, 'EdDSA');
  assert.equal(crypto.verify(null, Buffer.from('x'), decodedEdBytes.publicKey, crypto.sign(null, Buffer.from('x'), ed.privateKey)), true);
  assert.equal(coseKeyToPublicKey(Buffer.from(encodedEd, 'base64url')).algorithm, 'EdDSA');

  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecJwk = ec.publicKey.export({ format: 'jwk' });
  const ecKey = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(ecJwk.x, 'base64url')], [-3, Buffer.from(ecJwk.y, 'base64url')]]);
  const decodedEc = coseKeyToPublicKey(ecKey);
  assert.equal(decodedEc.algorithm, 'ES256');
  assert.equal(crypto.verify('sha256', Buffer.from('x'), decodedEc.publicKey, crypto.sign('sha256', Buffer.from('x'), ec.privateKey)), true);
  const encodedEc = cborMap([[1, cborInt(2)], [3, cborInt(-7)], [-1, cborInt(1)], [-2, Buffer.concat([Buffer.from([0x58, 32]), ecKey.get(-2)])], [-3, Buffer.concat([Buffer.from([0x58, 32]), ecKey.get(-3)])]]).toString('base64url');
  const decodedEcBytes = coseKeyToPublicKey(encodedEc);
  assert.equal(decodedEcBytes.algorithm, 'ES256');
  assert.equal(crypto.verify('sha256', Buffer.from('x'), decodedEcBytes.publicKey, crypto.sign('sha256', Buffer.from('x'), ec.privateKey)), true);
  assert.equal(coseKeyToPublicKey(new Map([[1, 3], [3, -257]])), null);
  assert.equal(coseKeyToPublicKey(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.alloc(31)], [-3, Buffer.alloc(32)]])), null);
});

test('attestation parser extracts credential ID and COSE public key', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const cose = cborMap([[1, cborInt(1)], [3, cborInt(-8)], [-1, cborInt(6)], [-2, Buffer.concat([Buffer.from([0x58, 32]), raw])]]);
  const authData = Buffer.concat([crypto.randomBytes(32), Buffer.from([0x41, 0, 0, 0, 1]), crypto.randomBytes(16), Buffer.from([0, 4]), Buffer.from('cred') , cose]);
  const attestation = cborMap([['fmt', cborText('none')], ['authData', Buffer.concat([Buffer.from([0x58, authData.length]), authData])], ['attStmt', Buffer.from([0xa0])]]).toString('base64url');
  const parsed = parseAttestationObject(attestation);
  assert.equal(parsed.format, 'none'); assert.equal(parsed.credentialId.toString(), 'cred'); assert.equal(parsed.algorithm, 'EdDSA');
  assert.equal(parseAttestationObject(Buffer.from('bad').toString('base64url')), null);
});

test('packed attestation verifies authenticator data and client data signature', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const cose = cborMap([[1, cborInt(1)], [3, cborInt(-8)], [-1, cborInt(6)], [-2, cborBytes(raw)]]);
  const authData = Buffer.concat([crypto.randomBytes(32), Buffer.from([0x41, 0, 0, 0, 1]), crypto.randomBytes(16), Buffer.from([0, 4]), Buffer.from('cred'), cose]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: 'registration-challenge', origin: 'https://relay.example' }));
  const signedData = Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]);
  const signature = crypto.sign(null, signedData, privateKey);
  const attStmt = cborMap([['alg', cborInt(-8)], ['sig', cborBytes(signature)]]);
  const attestation = cborMap([['fmt', cborText('packed')], ['authData', cborBytes(authData)], ['attStmt', attStmt]]).toString('base64url');
  const parsed = parseAttestationObject(attestation);
  assert.equal(verifyPackedAttestation({ parsed, clientDataJSON: clientDataJSON.toString('base64url') }), true);
  assert.equal(verifyPackedAttestation({ parsed, clientDataJSON: Buffer.from('forged').toString('base64url') }), false);
});

test('CBOR parser rejects truncated byte strings', () => {
  assert.equal(coseKeyToPublicKey(Buffer.from([0xa1, 1, 0x58, 32, 1]).toString('base64url')), null);
});
