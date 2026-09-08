import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRelayServer } from './http-server.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import {
  buildRedemptionRequest,
  buildConfirmationRequest,
  buildRevocationRequest,
  signRelayRequest,
} from './federation-directory-client.mjs';
import { canonicalJsonBytes } from './jcs.mjs';

// Task 4: the inbound relay verifier requires a fresh signed_at plus a 22-char
// base64url nonce on every relay request body. Task 10 threads the server's
// configured clock (`now`) and freshness window into the verifier, so every
// fixture signs `signed_at` relative to SERVER_NOW -- never wall-clock time.
const NONCE_OK = 'abcdefghijklmnopqrstuv';

// This relay is the invite ISSUER domain; PEER is the redeemer's relay, i.e. the
// signing peer that POSTs the three directory messages. Mirrors the domain roles
// in accept-federation-directory.test.mjs (RELAY_DOMAIN 'a.example' issues,
// 'b.example' redeems).
const RELAY = 'a.example';
const PEER = 'b.example';
const KID = 'relay-b-2026-08';
const SERVER_NOW = new Date('2026-08-30T12:00:30.000Z');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function makeWorld() {
  const relayKeys = crypto.generateKeyPairSync('ed25519');
  const identity = { key_id: KID, private_key_pem: relayKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const relayPub = relayKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const repo = createMemoryRepository({ registry: new Map() });
  return { identity, relayPub, repo };
}

function pinPeer(repo, relayPub, { kid = KID, domain = PEER } = {}) {
  return repo.upsertPeer({
    domain,
    relayUrl: `https://${domain}/relay`,
    keys: [{ kid, alg: 'Ed25519', publicKey: relayPub }],
    trustMode: 'tofu',
  });
}

// The Postgres-only feature probe the 501 pre-gate reads. The route never calls
// it -- its mere presence is "this relay has a durable federation outbox".
function withOutbox(repo) {
  repo.enqueueFederationForward = async () => ({ enqueued: true });
  return repo;
}

async function seedInvite(repo, { linkRef, segment, peerDomain = PEER, expiresAt } = {}) {
  await repo.createFederationDirectoryInvite({
    linkRef,
    issuerEndpointId: 'ep_codex@a.example',
    issuerOwnerId: 'usr_chris@a.example',
    peerDomain,
    codeHash: sha256(segment),
    expiresAt: expiresAt ?? new Date(Date.now() + 3_600_000),
    now: new Date(),
  }, null);
}

async function startServer(repo, opts = {}) {
  const federationMode = 'federationMode' in opts ? opts.federationMode : 'queue';
  const server = createRelayServer({
    repository: repo,
    registry: new Map(),
    relayDomain: RELAY,
    now: () => SERVER_NOW,
    federationMode,
    relayRequestFreshnessMs: opts.relayRequestFreshnessMs,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, port: server.address().port };
}

async function post(port, path, bodyObj, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(bodyObj),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function signedRedemption(identity, { linkRef, segment, now = SERVER_NOW, nonce = NONCE_OK }) {
  const { body } = buildRedemptionRequest({
    linkRef,
    code: `sigil-fed-invite:${RELAY}:${linkRef}:${segment}`,
    redeemer: { owner_id: 'usr_bob@b.example', endpoint_id: 'ep_c@b.example' },
    redeemerDomain: PEER,
    now,
    nonce,
  });
  const { signature, keyId } = signRelayRequest(canonicalJsonBytes(body), identity);
  return { body, headers: { 'sigil-relay-signature': signature, 'sigil-relay-key-id': keyId } };
}

function signedConfirmation(identity, { linkRef, now = SERVER_NOW, nonce = NONCE_OK }) {
  const { body } = buildConfirmationRequest({ linkRef, now, nonce });
  const { signature, keyId } = signRelayRequest(canonicalJsonBytes(body), identity);
  return { body, headers: { 'sigil-relay-signature': signature, 'sigil-relay-key-id': keyId } };
}

function signedRevocation(identity, { linkRef, now = SERVER_NOW, nonce = NONCE_OK }) {
  const { body } = buildRevocationRequest({ linkRef, now, nonce });
  const { signature, keyId } = signRelayRequest(canonicalJsonBytes(body), identity);
  return { body, headers: { 'sigil-relay-signature': signature, 'sigil-relay-key-id': keyId } };
}

// A pending issuer-side link owned by PEER, the shape acceptDirectoryRevocation
// needs to reach its real (non-noop) revoke branch.
function seedPendingLink(repo, linkRef) {
  return repo.createFederationDirectoryLink({
    linkRef,
    localOwnerId: 'usr_chris@a.example', localEndpointId: 'ep_codex@a.example',
    remoteOwnerId: 'usr_bob@b.example', remoteEndpointId: 'ep_c@b.example',
    remoteDomain: PEER, role: 'issuer', initiatedVia: 'invite', status: 'pending',
    localConfirmedAt: null, remoteConfirmedAt: SERVER_NOW, sourceInviteId: null, peerDomain: PEER,
  }, null);
}

// --- 501 pre-gate (no DB, no signature work) --------------------------------

test('memory-repo relay (no durable outbox) -> 501 FEDERATION_DIRECTORY_UNAVAILABLE', async () => {
  const { repo } = makeWorld();
  const { server, port } = await startServer(repo, { federationMode: 'queue' });
  try {
    const res = await post(port, '/v1/federation/directory/redemptions', { link_ref: crypto.randomUUID() });
    assert.equal(res.status, 501);
    assert.equal(res.body.code, 'FEDERATION_DIRECTORY_UNAVAILABLE');
    assert.deepEqual(res.body.details, {});
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('no federationMode -> 501 even with a durable outbox present', async () => {
  const { repo } = makeWorld();
  withOutbox(repo);
  const { server, port } = await startServer(repo, { federationMode: undefined });
  try {
    const res = await post(port, '/v1/federation/directory/confirmations', { link_ref: crypto.randomUUID() });
    assert.equal(res.status, 501);
    assert.equal(res.body.code, 'FEDERATION_DIRECTORY_UNAVAILABLE');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('501 fires before body read: an oversize body is still rejected as 501', async () => {
  const { repo } = makeWorld();
  const { server, port } = await startServer(repo, { federationMode: 'queue' });
  try {
    const huge = { link_ref: crypto.randomUUID(), pad: 'x'.repeat(2 * 1024 * 1024) };
    const res = await post(port, '/v1/federation/directory/revocations', huge);
    assert.equal(res.status, 501);
    assert.equal(res.body.code, 'FEDERATION_DIRECTORY_UNAVAILABLE');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- signature path (durable-outbox stub lets the pre-gate pass) ------------

test('well-formed signed redemption -> 202 and a pending issuer-side link row', async () => {
  const { repo, identity, relayPub } = makeWorld();
  withOutbox(repo);
  await pinPeer(repo, relayPub);
  const linkRef = crypto.randomUUID();
  await seedInvite(repo, { linkRef, segment: 'SEG' });
  const { server, port } = await startServer(repo, { federationMode: 'queue' });
  try {
    const { body, headers } = signedRedemption(identity, { linkRef, segment: 'SEG' });
    const res = await post(port, '/v1/federation/directory/redemptions', body, headers);
    assert.equal(res.status, 202);
    assert.equal(res.body.link_ref, linkRef);
    assert.deepEqual(res.body.issuer, { owner_id: 'usr_chris@a.example', endpoint_id: 'ep_codex@a.example' });
    const link = await repo.getFederationDirectoryLinkByRef(linkRef, null, {});
    assert.equal(link.status, 'pending');
    assert.equal(link.role, 'issuer');
    assert.ok(link.remote_confirmed_at);
    const invite = await repo.getFederationDirectoryInviteByRef(linkRef, null, {});
    assert.equal(invite.status, 'redeemed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('redemption whose signing kid is unpinned -> 403 PEER_NOT_TRUSTED', async () => {
  const { repo, identity } = makeWorld();
  withOutbox(repo);
  // no pinPeer -> getPeerByKid returns null
  const linkRef = crypto.randomUUID();
  await seedInvite(repo, { linkRef, segment: 'SEG' });
  const { server, port } = await startServer(repo, { federationMode: 'queue' });
  try {
    const { body, headers } = signedRedemption(identity, { linkRef, segment: 'SEG' });
    const res = await post(port, '/v1/federation/directory/redemptions', body, headers);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'PEER_NOT_TRUSTED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('confirmation with a tampered signature -> 401 RELAY_SIGNATURE_INVALID', async () => {
  const { repo, identity, relayPub } = makeWorld();
  withOutbox(repo);
  await pinPeer(repo, relayPub);
  const { server, port } = await startServer(repo, { federationMode: 'queue' });
  try {
    const { body, headers } = signedConfirmation(identity, { linkRef: crypto.randomUUID() });
    headers['sigil-relay-signature'] = Buffer.from('not-a-real-signature').toString('base64url');
    const res = await post(port, '/v1/federation/directory/confirmations', body, headers);
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'RELAY_SIGNATURE_INVALID');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- B3: nonce consumption inside the handler transaction -------------------

test('B3: a verbatim replayed revocation within the freshness window -> 409 RELAY_REPLAYED', async () => {
  const { repo, identity, relayPub } = makeWorld();
  withOutbox(repo);
  await pinPeer(repo, relayPub);
  const linkRef = crypto.randomUUID();
  await seedPendingLink(repo, linkRef);
  const { server, port } = await startServer(repo, { federationMode: 'queue' });
  try {
    // arrange: one signed revocation body, fixed nonce + signed_at == SERVER_NOW
    const { body, headers } = signedRevocation(identity, { linkRef });

    // act: POST it, then POST the identical bytes again
    const first = await post(port, '/v1/federation/directory/revocations', body, headers);
    const second = await post(port, '/v1/federation/directory/revocations', body, headers);

    // assert
    assert.equal(first.status, 202);
    assert.equal(first.body.outcome, 'revoked');
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'RELAY_REPLAYED');
    assert.deepEqual(second.body.details, {});
    const link = await repo.getFederationDirectoryLinkByRef(linkRef, null, {});
    assert.equal(link.status, 'revoked');
    const revocations = repo._debugGetAuditEvents().filter((e) => e.event_type === 'federation_directory.revocation_accepted');
    assert.equal(revocations.length, 1, 'the link must be revoked exactly once');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('B3: a revocation whose signed_at is older than relayRequestFreshnessMs -> 401 RELAY_REQUEST_STALE + audit', async () => {
  const { repo, identity, relayPub } = makeWorld();
  withOutbox(repo);
  await pinPeer(repo, relayPub);
  const linkRef = crypto.randomUUID();
  await seedPendingLink(repo, linkRef);
  const { server, port } = await startServer(repo, { federationMode: 'queue', relayRequestFreshnessMs: 60_000 });
  try {
    // arrange: signed_at is 5 minutes behind the server's pinned clock
    const staleAt = new Date(SERVER_NOW.getTime() - 300_000);
    const { body, headers } = signedRevocation(identity, { linkRef, now: staleAt });

    // act
    const res = await post(port, '/v1/federation/directory/revocations', body, headers);

    // assert
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'RELAY_REQUEST_STALE');
    const link = await repo.getFederationDirectoryLinkByRef(linkRef, null, {});
    assert.equal(link.status, 'pending', 'a stale request must not revoke the link');
    const rejected = repo._debugGetAuditEvents().filter(
      (e) => e.event_type === 'federation.inbound_rejected' && e.reason === 'RELAY_REQUEST_STALE',
    );
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].outcome, 'rejected');
    assert.equal(rejected[0].payload.signed_at_skew_seconds, 300);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('signed revocation for an unknown link_ref -> 202 no-op (no existence leak)', async () => {
  const { repo, identity, relayPub } = makeWorld();
  withOutbox(repo);
  await pinPeer(repo, relayPub);
  const { server, port } = await startServer(repo, { federationMode: 'queue' });
  try {
    const { body, headers } = signedRevocation(identity, { linkRef: crypto.randomUUID() });
    const res = await post(port, '/v1/federation/directory/revocations', body, headers);
    assert.equal(res.status, 202);
    assert.equal(res.body.outcome, 'noop');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
