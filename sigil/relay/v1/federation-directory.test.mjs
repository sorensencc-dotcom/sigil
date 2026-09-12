import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonicalJson } from './jcs.mjs';
import {
  hashJcsPayload,
  signDirectoryPayload,
  verifyDirectoryPayload,
  FederationDirectoryService,
} from './federation-directory.mjs';

function generateEd25519Pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

const keyA = generateEd25519Pair();
const keyB = generateEd25519Pair();

function createMockDb() {
  const invites = new Map();
  const directoryLinks = new Map();
  const peerRelays = new Map();
  const auditEvents = [];

  const db = {
    isPostgres: true,
    invites,
    directoryLinks,
    peerRelays,
    auditEvents,
    async query(sql, params = []) {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();

      if (normalizedSql.startsWith('INSERT INTO directory_invites')) {
        const [
          invite_id, invite_code, issuer_domain, issuer_owner_id, issuer_endpoint_id,
          allowed_capabilities_json, max_uses, signed_payload_json, expires_at, created_at
        ] = params;
        const record = {
          invite_id, invite_code, issuer_domain, issuer_owner_id, issuer_endpoint_id,
          allowed_capabilities_json, max_uses, uses_count: 0, state: 'active',
          signed_payload_json, expires_at, created_at, updated_at: created_at,
        };
        invites.set(invite_code, record);
        return { rows: [record], rowCount: 1 };
      }

      if (normalizedSql.startsWith('SELECT * FROM directory_invites')) {
        const [inviteCode] = params;
        const inv = invites.get(inviteCode);
        if (inv && inv.state === 'active' && new Date(inv.expires_at) > new Date()) {
          return [inv];
        }
        return [];
      }

      if (normalizedSql.startsWith('UPDATE directory_invites')) {
        const [uses_count, state, invite_id] = params;
        for (const [code, inv] of invites.entries()) {
          if (inv.invite_id === invite_id) {
            inv.uses_count = uses_count;
            inv.state = state;
            inv.updated_at = new Date();
            invites.set(code, inv);
            return { rows: [inv], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      if (normalizedSql.startsWith('INSERT INTO peer_relays')) {
        const [domain, relay_url, public_key_pem] = params;
        const record = { domain, relay_url, public_key_pem, status: 'active', updated_at: new Date() };
        peerRelays.set(domain, record);
        return { rows: [record], rowCount: 1 };
      }

      if (normalizedSql.startsWith('INSERT INTO directory_links')) {
        const [
          link_id, local_domain, local_owner_id, local_endpoint_id,
          remote_domain, remote_owner_id, remote_endpoint_id, capabilities_json
        ] = params;
        const record = {
          link_id, local_domain, local_owner_id, local_endpoint_id,
          remote_domain, remote_owner_id, remote_endpoint_id,
          state: 'active', capabilities_json, created_at: new Date(), updated_at: new Date(),
        };
        directoryLinks.set(link_id, record);
        return { rows: [record], rowCount: 1 };
      }

      if (normalizedSql.startsWith('UPDATE directory_links SET state = \'revoked\'')) {
        const [link_id] = params;
        const record = directoryLinks.get(link_id);
        if (record && record.state === 'active') {
          record.state = 'revoked';
          record.updated_at = new Date();
          directoryLinks.set(link_id, record);
          return [record];
        }
        return [];
      }

      if (normalizedSql.startsWith('INSERT INTO audit_events')) {
        const [id, actor_id, resource_id, metadata_json] = params;
        const record = { id, actor_id, resource_id, metadata_json, created_at: new Date() };
        auditEvents.push(record);
        return { rows: [record], rowCount: 1 };
      }

      throw new Error('Unhandled mock query: ' + normalizedSql);
    },
    async withTransaction(fn) {
      return fn(this);
    },
  };

  return db;
}

test('canonicalJson and hashJcsPayload deterministic RFC 8785 sorting', () => {
  const obj1 = { z: 1, a: 2, m: { y: 'test', b: 123 } };
  const obj2 = { a: 2, m: { b: 123, y: 'test' }, z: 1 };
  assert.equal(canonicalJson(obj1), canonicalJson(obj2));
  assert.equal(hashJcsPayload(obj1), hashJcsPayload(obj2));
});

test('signDirectoryPayload and verifyDirectoryPayload with Ed25519 keypairs', () => {
  const payload = { action: 'invite', endpoint: 'ep_test', nonce: '12345' };
  const signed = signDirectoryPayload(payload, keyA.privateKeyPem, 'key_a');
  assert.ok(signed.signature);
  assert.equal(signed.signature.algorithm, 'Ed25519');
  assert.equal(signed.signature.key_id, 'key_a');
  assert.ok(verifyDirectoryPayload(signed, keyA.publicKeyPem));
  assert.equal(verifyDirectoryPayload(signed, keyB.publicKeyPem), false);
});

test('assertFederationEnabled fails closed if federationMode is false or db is not postgres', async () => {
  const mockDb = createMockDb();
  const service = new FederationDirectoryService({
    db: mockDb,
    relayDomain: 'relay-a.test',
    keyId: 'key_a',
    privateKeyPem: keyA.privateKeyPem,
    publicKeyPem: keyA.publicKeyPem,
    federationMode: false,
  });

  await assert.rejects(
    service.createInvite({ issuerOwnerId: 'usr_1', issuerEndpointId: 'ep_1' }),
    (err) => err.code === 'FEDERATION_MODE_DISABLED' && err.statusCode === 501
  );
});

test('createInvite creates, signs, and persists single-use invite token', async () => {
  const mockDb = createMockDb();
  const service = new FederationDirectoryService({
    db: mockDb,
    relayDomain: 'relay-a.test',
    keyId: 'key_a',
    privateKeyPem: keyA.privateKeyPem,
    publicKeyPem: keyA.publicKeyPem,
    federationMode: true,
  });

  const invite = await service.createInvite({
    issuerOwnerId: 'usr_issuer',
    issuerEndpointId: 'ep_issuer',
    maxUses: 1,
    ttlMinutes: 60,
    allowedCapabilities: ['sigil.task/submit'],
  });

  assert.ok(invite.invite_id.startsWith('inv_'));
  assert.ok(invite.invite_code.startsWith('sigil_inv_'));
  assert.equal(invite.issuer_domain, 'relay-a.test');
  assert.ok(verifyDirectoryPayload(invite.signed_payload, keyA.publicKeyPem));

  const stored = mockDb.invites.get(invite.invite_code);
  assert.ok(stored);
  assert.equal(stored.state, 'active');
  assert.equal(stored.max_uses, 1);
});

test('handleLinkRedemption accepts valid signed redemption request and transitions invite to exhausted', async () => {
  const dbA = createMockDb();
  const serviceA = new FederationDirectoryService({
    db: dbA,
    relayDomain: 'relay-a.test',
    keyId: 'key_a',
    privateKeyPem: keyA.privateKeyPem,
    publicKeyPem: keyA.publicKeyPem,
    federationMode: true,
  });

  const invite = await serviceA.createInvite({
    issuerOwnerId: 'usr_issuer',
    issuerEndpointId: 'ep_issuer',
    maxUses: 1,
    ttlMinutes: 60,
  });

  const redemptionReq = {
    invite_code: invite.invite_code,
    redeemer_domain: 'relay-b.test',
    redeemer_owner_id: 'usr_redeemer',
    redeemer_endpoint_id: 'ep_redeemer',
    redeemer_public_key_pem: keyB.publicKeyPem,
    nonce: 'nonce_test_1',
    timestamp: new Date().toISOString(),
  };

  const signedReq = signDirectoryPayload(redemptionReq, keyB.privateKeyPem, 'key_b');
  const result = await serviceA.handleLinkRedemption(signedReq);

  assert.ok(result.link_id.startsWith('link_'));
  assert.equal(result.issuer_domain, 'relay-a.test');
  assert.equal(result.issuer_owner_id, 'usr_issuer');
  assert.equal(result.issuer_public_key_pem, keyA.publicKeyPem);

  // Invite should be exhausted
  const inv = dbA.invites.get(invite.invite_code);
  assert.equal(inv.uses_count, 1);
  assert.equal(inv.state, 'exhausted');

  // Peer relay registered
  assert.ok(dbA.peerRelays.has('relay-b.test'));

  // Link created
  assert.ok(dbA.directoryLinks.has(result.link_id));
});

test('handleLinkRedemption fails closed on invalid signature or exhausted invite', async () => {
  const dbA = createMockDb();
  const serviceA = new FederationDirectoryService({
    db: dbA,
    relayDomain: 'relay-a.test',
    keyId: 'key_a',
    privateKeyPem: keyA.privateKeyPem,
    publicKeyPem: keyA.publicKeyPem,
    federationMode: true,
  });

  const invite = await serviceA.createInvite({
    issuerOwnerId: 'usr_issuer',
    issuerEndpointId: 'ep_issuer',
    maxUses: 1,
  });

  const redemptionReq = {
    invite_code: invite.invite_code,
    redeemer_domain: 'relay-b.test',
    redeemer_owner_id: 'usr_redeemer',
    redeemer_endpoint_id: 'ep_redeemer',
    redeemer_public_key_pem: keyB.publicKeyPem,
    nonce: 'nonce_test_invalid',
    timestamp: new Date().toISOString(),
  };

  // Sign with keyA instead of keyB (signature mismatch)
  const invalidSigReq = signDirectoryPayload(redemptionReq, keyA.privateKeyPem, 'key_a');
  await assert.rejects(
    serviceA.handleLinkRedemption(invalidSigReq),
    (err) => err.code === 'INVALID_SIGNATURE' && err.statusCode === 400
  );

  // Perform valid redemption
  const validSigReq = signDirectoryPayload(redemptionReq, keyB.privateKeyPem, 'key_b');
  await serviceA.handleLinkRedemption(validSigReq);

  // Attempt duplicate redemption on exhausted single-use invite
  await assert.rejects(
    serviceA.handleLinkRedemption(validSigReq),
    (err) => err.code === 'INVITE_NOT_FOUND' || err.code === 'INVITE_USAGE_EXHAUSTED'
  );
});

test('redeemInvite performs reciprocal cross-relay handshake and persists local link', async () => {
  const dbA = createMockDb();
  const dbB = createMockDb();

  const serviceA = new FederationDirectoryService({
    db: dbA,
    relayDomain: 'relay-a.test',
    keyId: 'key_a',
    privateKeyPem: keyA.privateKeyPem,
    publicKeyPem: keyA.publicKeyPem,
    federationMode: true,
  });

  const invite = await serviceA.createInvite({
    issuerOwnerId: 'usr_issuer',
    issuerEndpointId: 'ep_issuer',
    maxUses: 1,
  });

  // Mock fetch router connecting relay B to relay A
  const fetchImpl = async (url, options) => {
    if (url === 'https://relay-a.test/v1/federation/directory/links') {
      const body = JSON.parse(options.body);
      const res = await serviceA.handleLinkRedemption(body);
      return {
        ok: true,
        status: 200,
        json: async () => res,
      };
    }
    return { ok: false, status: 404, text: async () => 'Not Found' };
  };

  const serviceB = new FederationDirectoryService({
    db: dbB,
    relayDomain: 'relay-b.test',
    keyId: 'key_b',
    privateKeyPem: keyB.privateKeyPem,
    publicKeyPem: keyB.publicKeyPem,
    federationMode: true,
    fetchImpl,
  });

  const established = await serviceB.redeemInvite({
    inviteCode: invite.invite_code,
    targetRelayUrl: 'https://relay-a.test',
    redeemerOwnerId: 'usr_redeemer',
    redeemerEndpointId: 'ep_redeemer',
  });

  assert.equal(established.status, 'established');
  assert.equal(established.peer_domain, 'relay-a.test');
  assert.equal(established.issuer_owner_id, 'usr_issuer');

  // Verify Relay B stored reciprocal link and peer
  assert.ok(dbB.peerRelays.has('relay-a.test'));
  assert.ok(dbB.directoryLinks.has(established.link_id));
});

test('revokeLink updates link state to revoked and writes audit event', async () => {
  const dbA = createMockDb();
  const serviceA = new FederationDirectoryService({
    db: dbA,
    relayDomain: 'relay-a.test',
    keyId: 'key_a',
    privateKeyPem: keyA.privateKeyPem,
    publicKeyPem: keyA.publicKeyPem,
    federationMode: true,
  });

  const invite = await serviceA.createInvite({
    issuerOwnerId: 'usr_issuer',
    issuerEndpointId: 'ep_issuer',
  });

  const redemptionReq = {
    invite_code: invite.invite_code,
    redeemer_domain: 'relay-b.test',
    redeemer_owner_id: 'usr_redeemer',
    redeemer_endpoint_id: 'ep_redeemer',
    redeemer_public_key_pem: keyB.publicKeyPem,
    nonce: 'nonce_revoke_test',
    timestamp: new Date().toISOString(),
  };

  const signedReq = signDirectoryPayload(redemptionReq, keyB.privateKeyPem, 'key_b');
  const result = await serviceA.handleLinkRedemption(signedReq);

  const revoked = await serviceA.revokeLink(result.link_id);
  assert.equal(revoked, true);

  const link = dbA.directoryLinks.get(result.link_id);
  assert.equal(link.state, 'revoked');
  assert.equal(dbA.auditEvents.length, 1);
  assert.equal(dbA.auditEvents[0].resource_id, result.link_id);

  // Calling revokeLink again on already-revoked link returns false
  const duplicateRevoke = await serviceA.revokeLink(result.link_id);
  assert.equal(duplicateRevoke, false);
});
