import crypto from 'node:crypto';
import { canonicalJson, canonicalJsonBytes } from './jcs.mjs';

export function hashJcsPayload(payload) {
  const canonicalStr = canonicalJson(payload);
  return crypto.createHash('sha256').update(canonicalStr, 'utf8').digest('hex');
}

export function signDirectoryPayload(payload, privateKeyPem, keyId) {
  const bodyCopy = { ...payload };
  delete bodyCopy.signature;
  const canonicalBytes = canonicalJsonBytes(bodyCopy);
  const signatureBytes = crypto.sign(null, canonicalBytes, privateKeyPem);
  return {
    ...bodyCopy,
    signature: {
      algorithm: 'Ed25519',
      key_id: keyId,
      value: 'base64url:' + signatureBytes.toString('base64url'),
    },
  };
}

export function verifyDirectoryPayload(signedPayload, publicKeyPem) {
  if (!signedPayload?.signature?.value?.startsWith('base64url:')) {
    return false;
  }
  const rawSig = signedPayload.signature.value.replace(/^base64url:/, '');
  const sigBuffer = Buffer.from(rawSig, 'base64url');
  const bodyCopy = { ...signedPayload };
  delete bodyCopy.signature;
  const canonicalBytes = canonicalJsonBytes(bodyCopy);
  try {
    return crypto.verify(null, canonicalBytes, publicKeyPem, sigBuffer);
  } catch {
    return false;
  }
}

export class FederationDirectoryService {
  constructor({
    db,
    relayDomain,
    keyId,
    privateKeyPem,
    publicKeyPem,
    federationMode = true,
    fetchImpl = globalThis.fetch,
  }) {
    this.db = db;
    this.relayDomain = relayDomain;
    this.keyId = keyId;
    this.privateKeyPem = privateKeyPem;
    this.publicKeyPem = publicKeyPem;
    this.federationMode = federationMode;
    this.fetchImpl = fetchImpl;
  }

  assertFederationEnabled() {
    if (!this.federationMode || !this.db || !this.db.isPostgres) {
      const err = new Error('Federation Directory protocol requires PostgreSQL and active --federation-mode.');
      err.statusCode = 501;
      err.code = 'FEDERATION_MODE_DISABLED';
      throw err;
    }
  }

  async createInvite({
    issuerOwnerId,
    issuerEndpointId,
    maxUses = 1,
    ttlMinutes = 1440,
    allowedCapabilities = ['sigil.core/read_shared_context', 'sigil.task/submit'],
  }) {
    this.assertFederationEnabled();
    const inviteId = 'inv_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex');
    const inviteCode = 'sigil_inv_' + crypto.randomBytes(16).toString('hex');
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + ttlMinutes * 60 * 1000);
    const invitePayload = {
      invite_id: inviteId,
      issuer_domain: this.relayDomain,
      issuer_owner_id: issuerOwnerId,
      issuer_endpoint_id: issuerEndpointId,
      allowed_capabilities: allowedCapabilities,
      max_uses: maxUses,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    };
    const signedPayload = signDirectoryPayload(invitePayload, this.privateKeyPem, this.keyId);
    await this.db.query(
      'INSERT INTO directory_invites (' +
      '  invite_id, invite_code, issuer_domain, issuer_owner_id, issuer_endpoint_id,' +
      '  allowed_capabilities_json, max_uses, uses_count, state, signed_payload_json,' +
      '  expires_at, created_at, updated_at' +
      ') VALUES (, , , , , , , 0, \'active\', , , , )',
      [
        inviteId,
        inviteCode,
        this.relayDomain,
        issuerOwnerId,
        issuerEndpointId,
        JSON.stringify(allowedCapabilities),
        maxUses,
        JSON.stringify(signedPayload),
        expiresAt,
        createdAt,
      ]
    );
    return {
      invite_id: inviteId,
      invite_code: inviteCode,
      issuer_domain: this.relayDomain,
      expires_at: expiresAt.toISOString(),
      signed_payload: signedPayload,
    };
  }

  async redeemInvite({
    inviteCode,
    targetRelayUrl,
    redeemerOwnerId,
    redeemerEndpointId,
  }) {
    this.assertFederationEnabled();
    const timestamp = new Date().toISOString();
    const nonce = 'nonce_' + crypto.randomBytes(8).toString('hex');
    const redemptionRequest = {
      invite_code: inviteCode,
      redeemer_domain: this.relayDomain,
      redeemer_owner_id: redeemerOwnerId,
      redeemer_endpoint_id: redeemerEndpointId,
      redeemer_public_key_pem: this.publicKeyPem,
      nonce,
      timestamp,
    };
    const signedRequest = signDirectoryPayload(redemptionRequest, this.privateKeyPem, this.keyId);
    const targetUrl = targetRelayUrl.replace(/\/$/, '') + '/v1/federation/directory/links';
    const response = await this.fetchImpl(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sigil-Origin-Domain': this.relayDomain,
      },
      body: JSON.stringify(signedRequest),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok && response.status !== 202) {
      const errorText = await response.text();
      const err = new Error('Directory redemption failed (' + response.status + '): ' + errorText);
      err.statusCode = response.status;
      err.code = 'DIRECTORY_REDEMPTION_FAILED';
      throw err;
    }
    const responseBody = await response.json();
    const { link_id, issuer_owner_id, issuer_endpoint_id, issuer_public_key_pem, allowed_capabilities } = responseBody;
    await this.db.withTransaction(async (tx) => {
      await tx.query(
        'INSERT INTO peer_relays (domain, relay_url, public_key_pem, status, created_at, updated_at) ' +
        'VALUES ($1, $2, $3, \'active\', NOW(), NOW()) ' +
        'ON CONFLICT (domain) DO UPDATE ' +
        'SET relay_url = EXCLUDED.relay_url, ' +
        '    public_key_pem = EXCLUDED.public_key_pem, ' +
        '    status = \'active\', ' +
        '    updated_at = NOW()',
        [responseBody.issuer_domain || new URL(targetRelayUrl).hostname, targetRelayUrl, issuer_public_key_pem]
      );
      await tx.query(
        'INSERT INTO directory_links ( ' +
        '  link_id, local_domain, local_owner_id, local_endpoint_id, ' +
        '  remote_domain, remote_owner_id, remote_endpoint_id, ' +
        '  state, capabilities_json, created_at, updated_at ' +
        ') VALUES ($1, $2, $3, $4, $5, $6, $7, \'active\', $8, NOW(), NOW()) ' +
        'ON CONFLICT (link_id) DO UPDATE ' +
        'SET state = \'active\', capabilities_json = EXCLUDED.capabilities_json, updated_at = NOW()',
        [
          link_id,
          this.relayDomain,
          redeemerOwnerId,
          redeemerEndpointId,
          responseBody.issuer_domain || new URL(targetRelayUrl).hostname,
          issuer_owner_id,
          issuer_endpoint_id,
          JSON.stringify(allowed_capabilities),
        ]
      );
    });
    return {
      status: 'established',
      link_id,
      peer_domain: responseBody.issuer_domain,
      issuer_owner_id,
      issuer_endpoint_id,
    };
  }

  async handleLinkRedemption(signedRequest) {
    this.assertFederationEnabled();
    const {
      invite_code,
      redeemer_domain,
      redeemer_owner_id,
      redeemer_endpoint_id,
      redeemer_public_key_pem,
    } = signedRequest;
    if (!verifyDirectoryPayload(signedRequest, redeemer_public_key_pem)) {
      const err = new Error('Invalid Ed25519 signature on redemption payload.');
      err.statusCode = 400;
      err.code = 'INVALID_SIGNATURE';
      throw err;
    }
    return await this.db.withTransaction(async (tx) => {
      const inviteRows = await tx.query(
        'SELECT * FROM directory_invites WHERE invite_code = $1 AND state = \'active\' AND expires_at > NOW() FOR UPDATE',
        [invite_code]
      );
      const rows = Array.isArray(inviteRows) ? inviteRows : (inviteRows?.rows || []);
      if (!rows || rows.length === 0) {
        const err = new Error('Directory invite code is invalid, expired, or revoked.');
        err.statusCode = 404;
        err.code = 'INVITE_NOT_FOUND';
        throw err;
      }
      const invite = rows[0];
      if (invite.uses_count >= invite.max_uses) {
        const err = new Error('Directory invite usage limit exceeded.');
        err.statusCode = 410;
        err.code = 'INVITE_USAGE_EXHAUSTED';
        throw err;
      }
      const newUsesCount = invite.uses_count + 1;
      const newState = newUsesCount >= invite.max_uses ? 'exhausted' : 'active';
      await tx.query(
        'UPDATE directory_invites SET uses_count = $1, state = $2, updated_at = NOW() WHERE invite_id = $3',
        [newUsesCount, newState, invite.invite_id]
      );
      const linkId = 'link_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex');
      const allowedCapabilities = typeof invite.allowed_capabilities_json === 'string'
        ? JSON.parse(invite.allowed_capabilities_json)
        : invite.allowed_capabilities_json;
      await tx.query(
        'INSERT INTO peer_relays (domain, relay_url, public_key_pem, status, created_at, updated_at) ' +
        'VALUES ($1, $2, $3, \'active\', NOW(), NOW()) ' +
        'ON CONFLICT (domain) DO UPDATE ' +
        'SET public_key_pem = EXCLUDED.public_key_pem, status = \'active\', updated_at = NOW()',
        [redeemer_domain, 'https://' + redeemer_domain, redeemer_public_key_pem]
      );
      await tx.query(
        'INSERT INTO directory_links ( ' +
        '  link_id, local_domain, local_owner_id, local_endpoint_id, ' +
        '  remote_domain, remote_owner_id, remote_endpoint_id, ' +
        '  state, capabilities_json, created_at, updated_at ' +
        ') VALUES ($1, $2, $3, $4, $5, $6, $7, \'active\', $8, NOW(), NOW())',
        [
          linkId,
          this.relayDomain,
          invite.issuer_owner_id,
          invite.issuer_endpoint_id,
          redeemer_domain,
          redeemer_owner_id,
          redeemer_endpoint_id,
          JSON.stringify(allowedCapabilities),
        ]
      );
      return {
        link_id: linkId,
        issuer_domain: this.relayDomain,
        issuer_owner_id: invite.issuer_owner_id,
        issuer_endpoint_id: invite.issuer_endpoint_id,
        issuer_public_key_pem: this.publicKeyPem,
        allowed_capabilities: allowedCapabilities,
        created_at: new Date().toISOString(),
      };
    });
  }

  async revokeLink(linkId) {
    this.assertFederationEnabled();
    return await this.db.withTransaction(async (tx) => {
      const result = await tx.query(
        'UPDATE directory_links SET state = \'revoked\', updated_at = NOW() WHERE link_id = $1 AND state = \'active\' RETURNING *',
        [linkId]
      );
      const rows = Array.isArray(result) ? result : (result?.rows || []);
      if (!rows || rows.length === 0) {
        return false;
      }
      const revokedLink = rows[0];
      await tx.query(
        'INSERT INTO audit_events (id, actor_type, actor_id, event_type, resource_id, metadata_json, created_at) ' +
        'VALUES ($1, \'system\', $2, \'federation.directory_link_revoked\', $3, $4, NOW())',
        [
          'aud_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
          revokedLink.local_endpoint_id,
          linkId,
          JSON.stringify({
            remote_domain: revokedLink.remote_domain,
            remote_endpoint_id: revokedLink.remote_endpoint_id,
          }),
        ]
      );
      return true;
    });
  }
}