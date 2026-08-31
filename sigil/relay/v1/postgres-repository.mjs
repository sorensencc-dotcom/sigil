import pg from 'pg';
import crypto from 'node:crypto';
import { canTransition } from './delivery-state.mjs';
import { assertAssurance, boundedDirectoryExpiry } from './auth-policy.mjs';
import { withTransaction } from './with-transaction.mjs';
import { generateInviteCode, hashMatchTarget } from './directory-trust.mjs';

function rowToPeerRecord(row) {
  return {
    domain: row.domain,
    relayUrl: row.relay_url,
    wsUrl: row.ws_url,
    keys: row.keys,
    trustMode: row.trust_mode,
    discoveredAt: row.discovered_at instanceof Date ? row.discovered_at.toISOString() : row.discovered_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    lastResolvedAt: row.last_resolved_at instanceof Date ? row.last_resolved_at.toISOString() : row.last_resolved_at,
  };
}

export class PostgresRepository {
  constructor({ pool = new pg.Pool(), schema = 'public' } = {}) { this.pool = pool; this.schema = schema; }
  async query(text, values = []) { return this.pool.query(text, values); }
  async lookupIdempotency(endpointId, idempotencyKey, client = this.pool) {
    const result = await client.query(
      'SELECT message_id, canonical_hash FROM idempotency_keys WHERE endpoint_id = $1 AND idempotency_key = $2 AND expires_at > NOW()',
      [endpointId, idempotencyKey]
    );
    return result.rows[0] ?? null;
  }
  async lookupTaskRequest(taskId, conversationId, client = this.pool) {
    const result = await client.query(
      `SELECT message_id FROM envelopes WHERE conversation_id = $1 AND message_type = 'task.request' AND body->>'task_id' = $2 AND envelope_status = 'accepted' LIMIT 1`,
      [conversationId, taskId]
    );
    return result.rows[0] ?? null;
  }
  async lookupAcceptedMessageId(senderEndpointId, messageId, client = this.pool) {
    const result = await client.query(
      'SELECT message_id, idempotency_key FROM envelopes WHERE sender_endpoint_id = $1 AND message_id = $2 AND envelope_status = $3',
      [senderEndpointId, messageId, 'accepted']
    );
    return result.rows[0] ?? null;
  }
  async lookupCapabilityRegistration(capability, client = this.pool) {
    const result = await client.query('SELECT capability, namespace, risk_tier FROM capability_registry WHERE capability = $1', [capability]);
    return result.rows[0] ?? null;
  }
  // Resolves the message's sender endpoint so delivery-state transitions can
  // push a delivery.receipt to the sender via stream.notifyReceipt, without
  // the caller needing to carry the sender endpoint id itself (design §10).
  async lookupMessageSender(messageId, client = this.pool) {
    const result = await client.query('SELECT sender_endpoint_id FROM envelopes WHERE message_id = $1', [messageId]);
    return result.rows[0] ? { endpoint_id: result.rows[0].sender_endpoint_id } : null;
  }
  async lookupRecipientEndpoint(endpointId, client) {
    if (!client) throw new Error('Recipient lookup requires a transaction client');
    const result = await client.query(
      `SELECT e.endpoint_id, e.owner_id
       FROM endpoints e
       WHERE e.endpoint_id = $1 AND e.status = 'active'
         AND EXISTS (
           SELECT 1 FROM endpoint_keys k
           WHERE k.endpoint_id = e.endpoint_id AND k.status = 'active'
         )`,
      [endpointId]
    );
    return result.rows[0] ?? null;
  }
  // No `client = this.pool` default here, unlike the other lookups above --
  // design §3 requires this one to always run on the transaction's client
  // since it takes a row lock; a lock taken on a throwaway pool connection
  // outside the transaction would be meaningless and immediately released.
  async lookupActiveCapabilityGrants(endpointId, now, client) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const result = await client.query(
      'SELECT capability, scope FROM capability_grants WHERE granted_to = $1 AND expires_at > $2 AND revoked_at IS NULL FOR UPDATE',
      [endpointId, timestamp]
    );
    return result.rows;
  }
  async registerHumanCredential({ humanId, endpointId, credentialId, type = 'webauthn', publicKey, algorithm, coseKey, now = new Date() } = {}) {
    if (type !== 'webauthn' || !humanId || !endpointId || !credentialId || !publicKey) throw Object.assign(new Error('Endpoint-bound WebAuthn credential is required'), { code: 'INVALID_ATTESTATION' });
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const result = await this.pool.query(
      `INSERT INTO human_credentials (credential_id, human_id, endpoint_id, type, public_key, status, valid_from, created_at)
       SELECT $1, h.human_id, $6, $2, $3, 'active', $4, $4
       FROM humans h JOIN endpoints e ON e.owner_id = h.human_id
       WHERE h.human_id = $5 AND e.endpoint_id = $6 AND h.status = 'active' AND e.status = 'active'
       RETURNING credential_id, human_id, type, status, valid_from, created_at`,
      [credentialId, type, publicKey, timestamp, humanId, endpointId]
    );
    if (!result.rows[0]) throw Object.assign(new Error('Human is not active or credential already exists'), { code: 'CREDENTIAL_UNAVAILABLE' });
    return { ...result.rows[0], algorithm: algorithm ?? null, coseKey: coseKey ?? null };
  }
  async lookupHumanCredential(credentialId, endpointId) {
    const result = await this.pool.query(
      `SELECT c.credential_id, c.human_id, c.type, c.public_key, c.status,
              c.valid_from, c.valid_until, c.endpoint_id, h.status AS human_status
       FROM human_credentials c JOIN humans h ON h.human_id = c.human_id
       WHERE c.credential_id = $1 AND c.endpoint_id = $2`, [credentialId, endpointId]
    );
    const row = result.rows[0];
    return row ? { credentialId: row.credential_id, humanId: row.human_id, endpointId: row.endpoint_id, type: row.type, publicKey: row.public_key, status: row.status, humanStatus: row.human_status, validFrom: row.valid_from, validUntil: row.valid_until } : null;
  }

  async createApprovalChallenge(challenge) {
    const result = await this.pool.query(
      `INSERT INTO approval_challenges (challenge_id, endpoint_id, action_hash, webauthn_challenge, callback_url, token_hash, status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
       RETURNING challenge_id, endpoint_id, action_hash, webauthn_challenge, callback_url, status, created_at, expires_at`,
      [challenge.id, challenge.endpointId, challenge.actionHash, challenge.webauthnChallenge, challenge.callbackUrl, crypto.createHash('sha256').update(challenge.token).digest('hex'), new Date().toISOString(), challenge.expiresAt]
    );
    return result.rows[0];
  }

  async getApprovalChallenge(challengeId) {
    const result = await this.pool.query('SELECT * FROM approval_challenges WHERE challenge_id = $1', [challengeId]);
    const row = result.rows[0];
    return row ? { id: row.challenge_id, endpointId: row.endpoint_id, actionHash: row.action_hash, webauthnChallenge: row.webauthn_challenge, callbackUrl: row.callback_url, expiresAt: row.expires_at, used: row.status === 'consumed', consuming: row.status === 'consuming' } : null;
  }

  async finalizeApprovalDecision({ challengeId, humanId, credentialId, endpointId, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const locked = await client.query('SELECT * FROM approval_challenges WHERE challenge_id = $1 FOR UPDATE', [challengeId]);
      const challenge = locked.rows[0];
      if (!challenge || challenge.status !== 'pending' || challenge.endpoint_id !== endpointId || new Date(challenge.expires_at) <= new Date(timestamp)) throw Object.assign(new Error('Approval challenge expired or already consumed'), { code: 'APPROVAL_EXPIRED' });
      await client.query(`UPDATE approval_challenges SET status = 'consumed', consumed_at = $2 WHERE challenge_id = $1`, [challengeId, timestamp]);
      const decision = await client.query(
        `INSERT INTO approval_decisions (decision_id, human_id, credential_id, endpoint_id, action_hash, action_hash_algorithm, target, context_refs, scope, contract_version, nonce, status, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'sha256', '{}', '[]', 'approval', 'sigil/1', $6, 'approved', $7, $8)
         RETURNING decision_id, action_hash, status, created_at, expires_at`,
        [`decision_${crypto.randomUUID()}`, humanId, credentialId, endpointId, challenge.action_hash, challenge.challenge_id, timestamp, challenge.expires_at]
      );
      return decision.rows[0];
    });
  }
  async listInbox(endpointId, since = '', viewerOwnerId = null) {
    // The final SELECT deliberately never re-reads `deliveries` by id: a data-modifying
    // CTE in the same statement is not visible to sibling scans of the same table (they
    // run against the pre-update snapshot), so every column the caller needs is carried
    // straight out of `candidate` instead of joined back in post-update.
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT delivery_id, message_id, recipient_endpoint_id, queued_at FROM deliveries
         WHERE recipient_endpoint_id = $1 AND state IN ('queued', 'delivered') AND ($2 = '' OR queued_at > $2::timestamptz)
         ORDER BY queued_at, delivery_id
         FOR UPDATE SKIP LOCKED
       ),
       advanced AS (
         UPDATE deliveries SET state = 'delivered', delivered_at = NOW(), updated_at = NOW()
         WHERE delivery_id IN (SELECT delivery_id FROM candidate) AND state = 'queued'
       )
       SELECT c.delivery_id, c.message_id, c.recipient_endpoint_id, c.queued_at,
              e.protocol, e.message_type, e.body, e.context_refs, e.capabilities, e.correlation_id,
              e.sender_endpoint_id, e.sender_owner_id, e.recipient_endpoint_id AS env_recipient,
              e.conversation_id, e.idempotency_key, e.signature_algorithm, e.signature_key_id,
              e.signature_value, e.expires_at, e.created_at,
              (ea.acknowledged_endpoint_id IS NULL) AS sender_unverified
       FROM candidate c
       JOIN envelopes e ON e.message_id = c.message_id
       LEFT JOIN endpoint_acknowledgements ea ON ea.acknowledged_endpoint_id = e.sender_endpoint_id AND ea.viewer_owner_id = $3
       ORDER BY c.queued_at, c.delivery_id`, [endpointId, since, viewerOwnerId]
    );
    return result.rows.map((row) => ({
      delivery_id: row.delivery_id,
      message_id: row.message_id,
      queued_at: row.queued_at instanceof Date ? row.queued_at.toISOString() : row.queued_at,
      sender_unverified: row.sender_unverified,
      envelope: {
        protocol: row.protocol,
        message_id: row.message_id,
        conversation_id: row.conversation_id,
        message_type: row.message_type,
        sender: {
          endpoint_id: row.sender_endpoint_id,
          owner_id: row.sender_owner_id,
        },
        recipient: row.env_recipient ? {
          endpoint_id: row.env_recipient,
        } : undefined,
        body: typeof row.body === 'string' ? JSON.parse(row.body) : row.body,
        context_refs: row.context_refs ?? [],
        capabilities: row.capabilities ?? [],
        correlation_id: row.correlation_id,
        idempotency_key: row.idempotency_key,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
        signature: {
          algorithm: row.signature_algorithm,
          key_id: row.signature_key_id,
          value: row.signature_value,
        },
      }
    }));
  }
  async acknowledgeEndpoint({ viewerOwnerId, acknowledgedEndpointId, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const result = await client.query(`INSERT INTO endpoint_acknowledgements (viewer_owner_id, acknowledged_endpoint_id, acknowledged_at) VALUES ($1,$2,$3) ON CONFLICT (viewer_owner_id, acknowledged_endpoint_id) DO UPDATE SET acknowledged_at = $3 RETURNING *`, [viewerOwnerId, acknowledgedEndpointId, timestamp]);
      await client.query(`INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, object_type, object_id, outcome, created_at) VALUES ($1,'endpoint_acknowledgement.created',$2,$3,'endpoint',$2,'success',$4)`, [`audit_${crypto.randomUUID()}`, acknowledgedEndpointId, viewerOwnerId, timestamp]);
      return result.rows[0];
    });
  }
  async createEndpointWithAudit({ endpointId, ownerId, installationId, runtime, displayName, keyId, publicKey, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => { try {
      const endpoint = await client.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at) VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING *`, [endpointId, ownerId, runtime, installationId, displayName, timestamp]);
      await client.query(`INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ($1,$2,'Ed25519',$3,'active',$4)`, [keyId, endpointId, publicKey, timestamp]);
      await client.query(`INSERT INTO audit_events (event_id,event_type,subject_id,actor_id,object_type,object_id,outcome,created_at) VALUES ($1,'endpoint.created',$2,$3,'endpoint',$2,'success',$4)`, [`audit_${crypto.randomUUID()}`, endpointId, ownerId, timestamp]);
      return endpoint.rows[0];
    } catch (error) { if (error.code === '23505' && error.constraint === 'endpoints_owner_display_name_idx') throw Object.assign(new Error('An endpoint with this display name already exists for this owner'), { code: 'DISPLAY_NAME_COLLISION' }); throw error; } });
  }
  async createDirectoryInvite({ issuerEndpointId, issuerHumanId, expiresAt, homeRelay, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const { code, codeHash } = generateInviteCode();
    const inviteId = `invite_${crypto.randomUUID()}`;
    // expiresAt is optional at the repository layer -- boundedDirectoryExpiry
    // (Task 2, auth-policy.mjs) supplies and validates the spec §7 [1h, 7d]
    // default/bound so callers (this test, and the HTTP route in Task 7)
    // don't have to compute it themselves.
    const expiry = boundedDirectoryExpiry({ now, expiresAt });
    const result = await this.pool.query(
      `INSERT INTO directory_invites (invite_id, issuer_endpoint_id, issuer_human_id, code_hash, status, expires_at, home_relay, created_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
       RETURNING invite_id, expires_at`,
      [inviteId, issuerEndpointId, issuerHumanId, codeHash, expiry.toISOString(), homeRelay, timestamp]
    );
    return { invite_id: result.rows[0].invite_id, code, expires_at: result.rows[0].expires_at };
  }
  // Spec §3.1 step 3/4: single generic error for wrong/expired/revoked/
  // unknown code, and an explicit endpoint-ownership check (round 1 review
  // finding) before any code check is treated as successful.
  async redeemDirectoryInvite({ code, redeemerEndpointId, redeemerHumanId, homeRelay, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    return this.withTransaction(async (client) => {
      const ownership = await client.query('SELECT owner_id FROM endpoints WHERE endpoint_id = $1', [redeemerEndpointId]);
      if (!ownership.rows[0] || ownership.rows[0].owner_id !== redeemerHumanId) {
        throw Object.assign(new Error('Invite code is invalid or expired'), { code: 'INVITE_UNAVAILABLE' });
      }
      const invite = await client.query(
        `SELECT * FROM directory_invites WHERE code_hash = $1 AND status = 'pending' AND expires_at > $2 FOR UPDATE`,
        [codeHash, timestamp]
      );
      if (!invite.rows[0]) throw Object.assign(new Error('Invite code is invalid or expired'), { code: 'INVITE_UNAVAILABLE' });
      const row = invite.rows[0];
      // A human can't link to their own other endpoint via their own invite
      // (directory_links' human_a <> human_b CHECK enforces this at the DB
      // layer too) -- reject before mutating the invite so a self-redeem
      // attempt doesn't burn a code the issuer could otherwise still use.
      if (row.issuer_human_id === redeemerHumanId) {
        throw Object.assign(new Error('Invite code is invalid or expired'), { code: 'INVITE_UNAVAILABLE' });
      }
      await client.query(`UPDATE directory_invites SET status = 'redeemed', redeemed_by_human_id = $1, redeemed_at = $2 WHERE invite_id = $3`, [redeemerHumanId, timestamp, row.invite_id]);
      const [endpointA, endpointB] = [row.issuer_endpoint_id, redeemerEndpointId].sort();
      const [humanA, humanB] = endpointA === row.issuer_endpoint_id ? [row.issuer_human_id, redeemerHumanId] : [redeemerHumanId, row.issuer_human_id];
      const aConfirmedAt = endpointA === row.issuer_endpoint_id ? null : timestamp;
      const bConfirmedAt = endpointA === row.issuer_endpoint_id ? timestamp : null;
      const bConfirmedBy = endpointA === row.issuer_endpoint_id ? redeemerHumanId : null;
      const aConfirmedBy = endpointA === row.issuer_endpoint_id ? null : redeemerHumanId;
      let link;
      try {
        link = await client.query(
          `INSERT INTO directory_links (link_id, endpoint_a, endpoint_b, human_a, human_b, status, initiated_via, source_invite_id, a_confirmed_at, b_confirmed_at, a_confirmed_by, b_confirmed_by, home_relay, created_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', 'invite', $6, $7, $8, $9, $10, $11, $12)
           RETURNING link_id, status`,
          [`link_${crypto.randomUUID()}`, endpointA, endpointB, humanA, humanB, row.invite_id, aConfirmedAt, bConfirmedAt, aConfirmedBy, bConfirmedBy, homeRelay, timestamp]
        );
      } catch (error) {
        if (error.code === '23505') throw Object.assign(new Error('A directory link already exists or is pending between these endpoints'), { code: 'DIRECTORY_LINK_CONFLICT' });
        throw error;
      }
      return { link_id: link.rows[0].link_id, status: link.rows[0].status };
    });
  }
  async createDirectoryMatchRequest({ issuerEndpointId, issuerHumanId, issuer, matchTarget, expiresAt, homeRelay, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const requestId = `dreq_${crypto.randomUUID()}`;
    // Same [1h, 7d] bound and Date-coercion as createDirectoryInvite's
    // expiresAt handling (boundedDirectoryExpiry's own error message names
    // both invite and match expiry) -- the brief's literal snippet called
    // expiresAt.toISOString() directly, which throws on an undefined/string
    // expiresAt and skips the spec §7 bound entirely.
    const expiry = boundedDirectoryExpiry({ now, expiresAt });
    await this.pool.query(
      `INSERT INTO directory_match_requests (request_id, issuer_endpoint_id, issuer_human_id, issuer, match_target_hash, status, expires_at, home_relay, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)`,
      [requestId, issuerEndpointId, issuerHumanId, issuer, hashMatchTarget(matchTarget), expiry.toISOString(), homeRelay, timestamp]
    );
    return { request_id: requestId };
  }
  // Spec §3.2 step 2: single-client row-locking claim, same pattern as
  // lookupActiveCapabilityGrants's FOR UPDATE. SKIP LOCKED (not plain FOR
  // UPDATE) is required here: with plain FOR UPDATE a second concurrent
  // caller would block on the first caller's lock, then -- once the first
  // caller commits and flips the row to 'matched' -- re-evaluate the WHERE
  // clause and see zero pending rows, which is correct but only after an
  // unnecessary wait. SKIP LOCKED instead lets the second caller skip the
  // locked-but-still-pending row immediately and see "no pending row" (and
  // return null) without blocking at all. Only the first caller to reach
  // this transaction for a given pending row wins; a second caller for the
  // same (issuer, target) sees no pending row and gets null, never an
  // error -- the caller maps null to the same generic non-match failure as
  // an invalid invite (spec §3.2 step 4).
  async claimDirectoryMatch({ issuer, matchTarget, matchedHumanId, now = new Date(), client } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const targetHash = hashMatchTarget(matchTarget);
    const run = async (txClient) => {
      const candidate = await txClient.query(
        `SELECT request_id FROM directory_match_requests
         WHERE issuer = $1 AND match_target_hash = $2 AND status = 'pending' AND expires_at > $3
         FOR UPDATE SKIP LOCKED LIMIT 1`,
        [issuer, targetHash, timestamp]
      );
      if (!candidate.rows[0]) return null;
      await txClient.query(`UPDATE directory_match_requests SET status = 'matched', matched_human_id = $1, matched_at = $2 WHERE request_id = $3`, [matchedHumanId, timestamp, candidate.rows[0].request_id]);
      return { request_id: candidate.rows[0].request_id };
    };
    return client ? run(client) : this.withTransaction(run);
  }
  async nominateDirectoryLinkEndpoint({ requestId, nominatedEndpointId, nominatedHumanId, homeRelay, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const ownership = await client.query('SELECT owner_id FROM endpoints WHERE endpoint_id = $1', [nominatedEndpointId]);
      if (!ownership.rows[0] || ownership.rows[0].owner_id !== nominatedHumanId) {
        throw Object.assign(new Error('Match request is invalid or already consumed'), { code: 'MATCH_UNAVAILABLE' });
      }
      const request = await client.query(`SELECT * FROM directory_match_requests WHERE request_id = $1 AND status = 'matched' AND matched_human_id = $2 FOR UPDATE`, [requestId, nominatedHumanId]);
      if (!request.rows[0]) throw Object.assign(new Error('Match request is invalid or already consumed'), { code: 'MATCH_UNAVAILABLE' });
      const row = request.rows[0];
      // Mirrors redeemDirectoryInvite's human_a <> human_b guard: without
      // this check, a human who matched their own request from a second
      // endpoint they own would hit directory_links' CHECK (human_a <>
      // human_b) constraint on INSERT below and get a raw, unhandled
      // Postgres error instead of the generic application error code.
      // Checked before the request is marked consumed, same as the invite
      // path checks before marking the invite redeemed.
      if (row.issuer_human_id === nominatedHumanId) {
        throw Object.assign(new Error('Match request is invalid or already consumed'), { code: 'MATCH_UNAVAILABLE' });
      }
      await client.query(`UPDATE directory_match_requests SET status = 'consumed', consumed_at = $1 WHERE request_id = $2`, [timestamp, requestId]);
      const [endpointA, endpointB] = [row.issuer_endpoint_id, nominatedEndpointId].sort();
      const [humanA, humanB] = endpointA === row.issuer_endpoint_id ? [row.issuer_human_id, nominatedHumanId] : [nominatedHumanId, row.issuer_human_id];
      let link;
      try {
        link = await client.query(
          `INSERT INTO directory_links (link_id, endpoint_a, endpoint_b, human_a, human_b, status, initiated_via, source_request_id, a_confirmed_at, b_confirmed_at, a_confirmed_by, b_confirmed_by, home_relay, created_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', 'oidc_match', $6, $7, $8, $9, $10, $11, $12)
           RETURNING link_id, status`,
          [`link_${crypto.randomUUID()}`, endpointA, endpointB, humanA, humanB, row.request_id,
            endpointA === row.issuer_endpoint_id ? null : timestamp,
            endpointA === row.issuer_endpoint_id ? timestamp : null,
            endpointA === row.issuer_endpoint_id ? null : nominatedHumanId,
            endpointA === row.issuer_endpoint_id ? nominatedHumanId : null,
            homeRelay, timestamp]
        );
      } catch (error) {
        if (error.code === '23505') throw Object.assign(new Error('A directory link already exists or is pending between these endpoints'), { code: 'DIRECTORY_LINK_CONFLICT' });
        throw error;
      }
      return { link_id: link.rows[0].link_id, status: link.rows[0].status };
    });
  }
  // Confirmation is actor-bound (spec §5): confirmingHumanId must equal
  // human_a or human_b of the row, never inferred from endpoint-key auth.
  async confirmDirectoryLink({ linkId, confirmingHumanId, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const current = await client.query('SELECT * FROM directory_links WHERE link_id = $1 FOR UPDATE', [linkId]);
      if (!current.rows[0]) throw Object.assign(new Error('Directory link not found'), { code: 'LINK_UNAVAILABLE' });
      const row = current.rows[0];
      if (row.status !== 'pending') return { link_id: linkId, status: row.status };
      if (confirmingHumanId !== row.human_a && confirmingHumanId !== row.human_b) {
        throw Object.assign(new Error('Confirming human is not a party to this link'), { code: 'CONFIRMATION_ACTOR_MISMATCH' });
      }
      const isA = confirmingHumanId === row.human_a;
      if (isA && row.a_confirmed_at) return { link_id: linkId, status: row.status };
      if (!isA && row.b_confirmed_at) return { link_id: linkId, status: row.status };
      const otherConfirmed = isA ? row.b_confirmed_at : row.a_confirmed_at;
      const nextStatus = otherConfirmed ? 'active' : 'pending';
      const result = await client.query(
        isA
          ? `UPDATE directory_links SET a_confirmed_at = $1, a_confirmed_by = $2, status = $3 WHERE link_id = $4 RETURNING link_id, status`
          : `UPDATE directory_links SET b_confirmed_at = $1, b_confirmed_by = $2, status = $3 WHERE link_id = $4 RETURNING link_id, status`,
        [timestamp, confirmingHumanId, nextStatus, linkId]
      );
      return result.rows[0];
    });
  }
  // Unilateral (spec §5): either party revokes without the other's consent.
  async revokeDirectoryLink({ linkId, revokingHumanId, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const current = await client.query('SELECT * FROM directory_links WHERE link_id = $1 FOR UPDATE', [linkId]);
      if (!current.rows[0]) throw Object.assign(new Error('Directory link not found'), { code: 'LINK_UNAVAILABLE' });
      const row = current.rows[0];
      if (row.status === 'revoked') return { link_id: linkId, status: 'revoked', duplicate: true };
      if (revokingHumanId !== row.human_a && revokingHumanId !== row.human_b) {
        throw Object.assign(new Error('Revoking human is not a party to this link'), { code: 'CONFIRMATION_ACTOR_MISMATCH' });
      }
      const result = await client.query(`UPDATE directory_links SET status = 'revoked', revoked_at = $1, revoked_by = $2 WHERE link_id = $3 RETURNING link_id, status`, [timestamp, revokingHumanId, linkId]);
      return { ...result.rows[0], duplicate: false };
    });
  }
  // No `client = this.pool` default -- same reasoning as
  // lookupActiveCapabilityGrants: this participates in accept-envelope's
  // transaction (Task 6) and must run on that transaction's client.
  async lookupActiveDirectoryLink(endpointIdA, endpointIdB, client) {
    const result = await client.query(
      `SELECT link_id, status FROM directory_links
       WHERE status = 'active' AND ((endpoint_a = $1 AND endpoint_b = $2) OR (endpoint_a = $2 AND endpoint_b = $1))`,
      [endpointIdA, endpointIdB]
    );
    return result.rows[0] ?? null;
  }
  async getDelivery(deliveryId, endpointId) {
    const result = await this.pool.query('SELECT * FROM deliveries WHERE delivery_id = $1 AND recipient_endpoint_id = $2', [deliveryId, endpointId]);
    if (!result.rows[0]) throw Object.assign(new Error('Delivery not found'), { code: 'DELIVERY_UNAVAILABLE' });
    return result.rows[0];
  }
  async claimDelivery({ workerId, leaseSeconds = 30, now = new Date() } = {}) {
    return this.withTransaction(async (client) => {
      const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
      const result = await client.query(
        `WITH candidate AS (
           SELECT delivery_id FROM deliveries
           WHERE state = 'queued' AND next_attempt_at <= $1 AND (lease_until IS NULL OR lease_until <= $1)
           ORDER BY next_attempt_at, queued_at, delivery_id
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE deliveries d SET lease_until = $2, lease_owner = $3, updated_at = $1
         FROM candidate c WHERE d.delivery_id = c.delivery_id
         RETURNING d.*`,
        [timestamp, new Date(new Date(timestamp).getTime() + leaseSeconds * 1000).toISOString(), workerId]
      );
      return result.rows[0] ? { ...result.rows[0], worker_id: workerId ?? null } : null;
    });
  }
  async saveDeliveryTransition(deliveryId, next, { workerId, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const result = await this.pool.query(
      `UPDATE deliveries SET state = $1, attempts = $2, updated_at = $3, next_attempt_at = $4,
       lease_until = NULL, lease_owner = NULL, delivered_at = $5, acknowledged_at = $6, processing_at = $7,
       processed_at = $8, failure_reason = $9 WHERE delivery_id = $10 AND lease_owner = $11 AND lease_until > $12 RETURNING *`,
      [next.state, next.attempts ?? 0, next.updated_at, next.next_attempt_at ?? next.updated_at,
        next.delivered_at ?? null, next.acknowledged_at ?? null, next.processing_at ?? null,
        next.processed_at ?? null, next.failure_reason ?? null, deliveryId, workerId, timestamp]
    );
    if (!result.rows[0]) throw Object.assign(new Error('Delivery lease lost or expired'), { code: 'DELIVERY_LEASE_LOST' });
    return result.rows[0];
  }
  async transitionDelivery(deliveryId, endpointId, state, fields = {}) {
    return this.withTransaction(async (client) => {
      const current = await client.query(
        'SELECT * FROM deliveries WHERE delivery_id = $1 AND recipient_endpoint_id = $2 FOR UPDATE', [deliveryId, endpointId]
      );
      if (!current.rows[0]) throw Object.assign(new Error('Delivery not found'), { code: 'DELIVERY_UNAVAILABLE' });
      const next = fields.next ?? { ...current.rows[0], state };
      const result = await client.query(
        `UPDATE deliveries SET state = $1, attempts = $2, updated_at = $3, delivered_at = $4,
         acknowledged_at = $5, processing_at = $6, processed_at = $7, failure_reason = $8
         WHERE delivery_id = $9 RETURNING *`,
        [next.state, next.attempts ?? current.rows[0].attempts, next.updated_at ?? new Date().toISOString(), next.delivered_at ?? null, next.acknowledged_at ?? null, next.processing_at ?? null, next.processed_at ?? null, next.failure_reason ?? null, deliveryId]
      );
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, endpoint_id, conversation_id, payload, reason, created_at)
         SELECT $1, $2, $3, $4, e.conversation_id, '{}', $5, $6
         FROM deliveries d JOIN envelopes e ON e.message_id = d.message_id WHERE d.delivery_id = $3`,
        [`audit_${crypto.randomUUID()}`, `delivery.${next.state}`, deliveryId, endpointId, next.failure_reason ?? null, next.updated_at ?? new Date().toISOString()]
      );
      return result.rows[0];
    });
  }
  async withTransaction(work) {
    return withTransaction(this.pool, work);
  }
  // Recipient inbox-depth limit (design §18 #23): derived live from
  // non-terminal deliveries rows rather than a separate counter, so it
  // never drifts from the actual outstanding queue.
  async countOpenDeliveries(recipientEndpointId, client) {
    const result = await client.query(
      `SELECT count(*) FROM deliveries WHERE recipient_endpoint_id = $1
       AND state NOT IN ('acknowledged', 'processed', 'delivery_rejected', 'dead_letter')`,
      [recipientEndpointId]
    );
    return Number(result.rows[0].count);
  }
  async reserveRateLimit(scopeKind, scopeId, windowStart, limit, client = this.pool) {
    const result = await client.query(
      `INSERT INTO quota_usage (scope_kind, scope_id, window_start, count) VALUES ($1, $2, $3, 1)
       ON CONFLICT (scope_kind, scope_id, window_start) DO UPDATE SET count = quota_usage.count + 1
       RETURNING count`,
      [scopeKind, scopeId, windowStart]
    );
    const count = result.rows[0].count;
    return { count, allowed: count <= limit };
  }
  async persistAcceptedEnvelope(row, client) {
    if (client) return this.#insertAcceptedEnvelope(row, client);
    try {
      return await this.withTransaction((txClient) => this.#insertAcceptedEnvelope(row, txClient));
    } catch (error) {
      if (error.code === '23505') {
        const existing = await this.lookupIdempotency(row.envelope.sender.endpoint_id, row.envelope.idempotency_key);
        if (existing) return { message_id: existing.message_id, duplicate: true };
      }
      throw error;
    }
  }
  async #insertAcceptedEnvelope(row, client) {
    await client.query(
      `INSERT INTO conversations (conversation_id, kind, created_by, created_at)
       VALUES ($1, 'direct', $2, $3)
       ON CONFLICT (conversation_id) DO NOTHING`,
      [row.envelope.conversation_id, row.envelope.sender.owner_id, row.envelope.created_at]
    );
    await client.query(
      `INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at)
       VALUES ($1, $2, 'member', $3, $4)
       ON CONFLICT (conversation_id, endpoint_id) DO NOTHING`,
      [row.envelope.conversation_id, row.envelope.sender.endpoint_id, row.envelope.sender.owner_id, row.envelope.created_at]
    );
    if (row.envelope.recipient?.endpoint_id) {
      await client.query(
        `INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at)
         VALUES ($1, $2, 'member', $3, $4)
         ON CONFLICT (conversation_id, endpoint_id) DO NOTHING`,
        [row.envelope.conversation_id, row.envelope.recipient.endpoint_id, row.envelope.sender.owner_id, row.envelope.created_at]
      );
    }
    const result = await client.query(
      `INSERT INTO envelopes (message_id, conversation_id, protocol, message_type, sender_endpoint_id, sender_owner_id, recipient_endpoint_id, broadcast_scope, body, context_refs, capabilities, correlation_id, idempotency_key, expires_at, created_at, signature_algorithm, signature_key_id, signature_value, canonical_bytes, action_hash, federation_hop, envelope_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'accepted') RETURNING message_id`,
      [row.envelope.message_id, row.envelope.conversation_id, row.envelope.protocol, row.envelope.message_type, row.envelope.sender.endpoint_id, row.envelope.sender.owner_id, row.envelope.recipient?.endpoint_id ?? null, row.envelope.broadcast_scope ?? null, row.envelope.body, row.envelope.context_refs, row.envelope.capabilities, row.envelope.correlation_id, row.envelope.idempotency_key, row.envelope.expires_at, row.envelope.created_at, row.envelope.signature.algorithm, row.envelope.signature.key_id, row.envelope.signature.value, row.canonical_bytes ?? null, row.action_hash ?? null, row.federation_hop === true]
    );
    const deliveryId = row.delivery_id ?? `del_${crypto.randomUUID()}`;
    if (row.envelope.recipient?.endpoint_id) {
      await client.query(
        `INSERT INTO deliveries (delivery_id, message_id, recipient_endpoint_id, state, attempts, queued_at, updated_at, next_attempt_at, federation_hop)
         VALUES ($1,$2,$3,'queued',0,$4,$4,$4,$5)`,
        [deliveryId, row.envelope.message_id, row.envelope.recipient.endpoint_id, row.envelope.created_at, row.federation_hop === true]
      );
    }
    await client.query(
      `INSERT INTO idempotency_keys (idempotency_key, endpoint_id, message_id, canonical_hash, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.envelope.idempotency_key, row.envelope.sender.endpoint_id, row.envelope.message_id, row.canonical_hash ?? row.action_hash ?? '', row.envelope.created_at, row.envelope.expires_at]
    );
    await client.query(
      `INSERT INTO audit_events (event_id, event_type, subject_id, actor_id, conversation_id, payload, created_at)
       VALUES ($1, 'envelope.accepted', $2, $3, $4, $5, $6)`,
      [`audit_${crypto.randomUUID()}`, row.envelope.message_id, row.envelope.sender.endpoint_id, row.envelope.conversation_id, JSON.stringify({ recipient_endpoint_id: row.envelope.recipient?.endpoint_id ?? null }), row.envelope.created_at]
    );
    return { message_id: result.rows[0].message_id, duplicate: false, delivery_id: row.envelope.recipient?.endpoint_id ? deliveryId : null };
  }
  async acknowledgeDelivery({ deliveryId, endpointId, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO delivery_acknowledgements (delivery_id, endpoint_id, acknowledged_at)
         VALUES ($1, $2, $3) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`,
        [deliveryId, endpointId, timestamp]
      );
      if (!inserted.rows[0]) {
        const existing = await client.query(
          'SELECT delivery_id, endpoint_id, acknowledged_at FROM delivery_acknowledgements WHERE delivery_id = $1',
          [deliveryId]
        );
        const receipt = existing.rows[0];
        if (!receipt) throw Object.assign(new Error('Delivery not found'), { code: 'DELIVERY_UNAVAILABLE' });
        if (receipt.endpoint_id !== endpointId) throw Object.assign(new Error('Delivery already acknowledged by a different endpoint'), { code: 'DELIVERY_UNAVAILABLE' });
        return { delivery_id: deliveryId, duplicate: true, acknowledged_at: receipt.acknowledged_at };
      }
      const current = await client.query('SELECT * FROM deliveries WHERE delivery_id = $1 AND recipient_endpoint_id = $2 FOR UPDATE', [deliveryId, endpointId]);
      if (!current.rows[0]) throw Object.assign(new Error('Delivery not found'), { code: 'DELIVERY_UNAVAILABLE' });
      if (current.rows[0].state !== 'acknowledged' && !canTransition(current.rows[0].state, 'acknowledged')) {
        throw Object.assign(new Error(`Invalid delivery transition: ${current.rows[0].state} -> acknowledged`), { code: 'INVALID_STATE_TRANSITION' });
      }
      const result = await client.query(
        `UPDATE deliveries SET state = 'acknowledged', updated_at = $1, acknowledged_at = $1 WHERE delivery_id = $2 RETURNING *`,
        [timestamp, deliveryId]
      );
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, endpoint_id, conversation_id, payload, created_at)
         SELECT $1, $2, $3, $4, e.conversation_id, '{}', $5
         FROM deliveries d JOIN envelopes e ON e.message_id = d.message_id WHERE d.delivery_id = $3`,
        [`audit_${crypto.randomUUID()}`, 'delivery.acknowledged', deliveryId, endpointId, timestamp]
      );
      return { delivery_id: deliveryId, duplicate: false, delivery: result.rows[0] };
    });
  }
  async createOidcIdentity({ issuer, subject, humanId, status = 'active', now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const result = await this.pool.query(
      `INSERT INTO oidc_identities (issuer, subject, human_id, status, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING issuer, subject, human_id, status, created_at`,
      [issuer, subject, humanId, status, timestamp]
    );
    return result.rows[0];
  }
  async lookupOidcIdentity(issuer, subject) {
    const result = await this.pool.query(
      'SELECT issuer, subject, human_id, status, created_at FROM oidc_identities WHERE issuer = $1 AND subject = $2',
      [issuer, subject]
    );
    return result.rows[0] ?? null;
  }
  async revokeOidcIdentity(issuer, subject, { now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const updated = await this.pool.query(
      `UPDATE oidc_identities SET status = 'revoked' WHERE issuer = $1 AND subject = $2 AND status <> 'revoked'
       RETURNING issuer, subject, human_id, status, created_at`,
      [issuer, subject]
    );
    if (updated.rows[0]) return { ...updated.rows[0], duplicate: false };
    const existing = await this.lookupOidcIdentity(issuer, subject);
    if (!existing) throw Object.assign(new Error('OIDC identity not found'), { code: 'IDENTITY_UNAVAILABLE' });
    return { ...existing, duplicate: true };
  }
  async linkAccount({ linkId, humanId, issuer, subject, nonceHash = null, stateHash = null, issuedAt = null, expiresAt = null, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    if (!nonceHash || !stateHash || !issuedAt || !expiresAt) throw Object.assign(new Error('Account-link ceremony is required'), { code: 'ACCOUNT_LINK_CEREMONY_REQUIRED' });
    const result = await this.pool.query(
      `INSERT INTO account_links (link_id, human_id, issuer, subject, nonce_hash, state_hash, issued_at, expires_at, consumed_at, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $9) RETURNING link_id, human_id, issuer, subject, nonce_hash, state_hash, issued_at, expires_at, consumed_at, status, created_at`,
      [linkId, humanId, issuer, subject, nonceHash, stateHash, new Date(issuedAt).toISOString(), new Date(expiresAt).toISOString(), timestamp]
    );
    return result.rows[0];
  }
  async unlinkAccount(linkId, { now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const current = await client.query('SELECT * FROM account_links WHERE link_id = $1 FOR UPDATE', [linkId]);
      const link = current.rows[0];
      if (!link) throw Object.assign(new Error('Account link not found'), { code: 'LINK_UNAVAILABLE' });
      if (link.status === 'unlinked') return { ...link, duplicate: true };
      const remaining = await client.query(
        `SELECT
           (SELECT count(*) FROM account_links WHERE human_id = $1 AND status = 'active' AND link_id <> $2) AS other_links,
           (SELECT count(*) FROM human_credentials WHERE human_id = $1 AND status = 'active') AS credentials`,
        [link.human_id, linkId]
      );
      const { other_links: otherLinks, credentials } = remaining.rows[0];
      if (Number(otherLinks) === 0 && Number(credentials) === 0) {
        throw Object.assign(new Error('Unlinking would leave no recoverable authentication method'), { code: 'LOCKOUT_REFUSED' });
      }
      const updated = await client.query(
        `UPDATE account_links SET status = 'unlinked' WHERE link_id = $1 RETURNING link_id, human_id, issuer, subject, status, created_at`,
        [linkId]
      );
      return { ...updated.rows[0], duplicate: false };
    });
  }
  async createHumanSession({ sessionId, humanId, authenticationMethod, assurance, deviceContext = {}, issuedAt = new Date(), expiresAt, now = new Date(), client = this.pool } = {}) {
    assertAssurance(assurance);
    const issued = issuedAt instanceof Date ? issuedAt.toISOString() : new Date(issuedAt).toISOString();
    const expires = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt).toISOString();
    const result = await client.query(
      `INSERT INTO human_sessions (session_id, human_id, authentication_method, assurance, device_context, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING session_id, human_id, authentication_method, assurance, device_context, issued_at, version, expires_at, revoked_at`,
      [sessionId, humanId, authenticationMethod, assurance, JSON.stringify(deviceContext), issued, expires]
    );
    return result.rows[0];
  }
  async revokeHumanSession(sessionId, { now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const updated = await this.pool.query(
      `UPDATE human_sessions SET revoked_at = $1 WHERE session_id = $2 AND revoked_at IS NULL
       RETURNING session_id, human_id, authentication_method, assurance, device_context, issued_at, version, expires_at, revoked_at`,
      [timestamp, sessionId]
    );
    if (updated.rows[0]) return { ...updated.rows[0], duplicate: false };
    const existing = await this.pool.query('SELECT * FROM human_sessions WHERE session_id = $1', [sessionId]);
    if (!existing.rows[0]) throw Object.assign(new Error('Session not found'), { code: 'SESSION_UNAVAILABLE' });
    return { ...existing.rows[0], duplicate: true };
  }
  async issueEndpointToken({ tokenId, endpointId, now = new Date(), expiresAt } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const expires = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt ?? new Date(timestamp).getTime() + 24 * 60 * 60 * 1000).toISOString();
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await this.pool.query(
      `INSERT INTO endpoint_tokens (token_id, endpoint_id, token_hash, status, created_at, expires_at)
       VALUES ($1, $2, $3, 'active', $4, $5) RETURNING token_id, endpoint_id, status, created_at, expires_at`,
      [tokenId, endpointId, tokenHash, timestamp, expires]
    );
    return { ...result.rows[0], token };
  }
  async rotateEndpointToken({ oldTokenId, newTokenId, endpointId, now = new Date(), expiresAt } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const expires = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt ?? new Date(timestamp).getTime() + 24 * 60 * 60 * 1000).toISOString();
    return this.withTransaction(async (client) => {
      const current = await client.query(
        `UPDATE endpoint_tokens SET status = 'revoked', revoked_at = $1
         WHERE token_id = $2 AND endpoint_id = $3 AND status = 'active' RETURNING token_id`,
        [timestamp, oldTokenId, endpointId]
      );
      if (!current.rows[0]) throw Object.assign(new Error('Token to rotate is not active for this endpoint'), { code: 'TOKEN_UNAVAILABLE' });
      const token = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const inserted = await client.query(
        `INSERT INTO endpoint_tokens (token_id, endpoint_id, token_hash, status, created_at, expires_at)
         VALUES ($1, $2, $3, 'active', $4, $5) RETURNING token_id, endpoint_id, status, created_at, expires_at`,
        [newTokenId, endpointId, tokenHash, timestamp, expires]
      );
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, actor_id, endpoint_id, payload, created_at)
         VALUES ($1, 'endpoint_token.rotated', $2, $3, $4, $5, $6)`,
        [`audit_${crypto.randomUUID()}`, newTokenId, endpointId, endpointId, JSON.stringify({ old_token_id: oldTokenId, new_token_id: newTokenId }), timestamp]
      );
      return { ...inserted.rows[0], token };
    });
  }
  async revokeEndpointToken(tokenId, { endpointId, now = new Date(), reason = null } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE endpoint_tokens SET status = 'revoked', revoked_at = $1
         WHERE token_id = $2 AND ($3::text IS NULL OR endpoint_id = $3) AND status = 'active'
         RETURNING token_id, endpoint_id, status, created_at, expires_at, revoked_at`,
        [timestamp, tokenId, endpointId ?? null]
      );
      if (!updated.rows[0]) throw Object.assign(new Error('Token not found or already revoked'), { code: 'TOKEN_UNAVAILABLE' });
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, actor_id, endpoint_id, reason, payload, created_at)
         VALUES ($1, 'endpoint_token.revoked', $2, $3, $3, $4, '{}', $5)`,
        [`audit_${crypto.randomUUID()}`, tokenId, updated.rows[0].endpoint_id, reason, timestamp]
      );
      return updated.rows[0];
    });
  }
  async createCapabilityGrant({ grantId, subject, capability, scope, purpose, provenance, issuer, grantedTo, grantedBy, now = new Date(), expiresAt } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const expires = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt).toISOString();
    const result = await this.pool.query(
      `INSERT INTO capability_grants (grant_id, capability, scope, granted_to, granted_by, granted_at, expires_at, subject, purpose, provenance, issuer, issued_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $6)
       RETURNING grant_id, capability, scope, granted_to, granted_by, granted_at, expires_at, subject, purpose, provenance, issuer, issued_at, revoked_at`,
      [grantId, capability, scope, grantedTo, grantedBy, timestamp, expires, subject ?? grantedTo, purpose ?? null, provenance ?? null, issuer ?? null]
    );
    return result.rows[0];
  }
  async revokeCapabilityGrant(grantId, { revokedBy, reason, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE capability_grants SET revoked_at = $1 WHERE grant_id = $2 AND revoked_at IS NULL
         RETURNING grant_id, capability, scope, granted_to, granted_by, granted_at, expires_at, subject, purpose, provenance, issuer, issued_at, revoked_at`,
        [timestamp, grantId]
      );
      if (!updated.rows[0]) {
        const existing = await client.query('SELECT * FROM capability_grants WHERE grant_id = $1', [grantId]);
        if (!existing.rows[0]) throw Object.assign(new Error('Capability grant not found'), { code: 'GRANT_UNAVAILABLE' });
        return { ...existing.rows[0], duplicate: true };
      }
      await client.query(
        `INSERT INTO capability_revocations (revocation_id, capability_grant_id, revoked_by, reason, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [`revocation_${crypto.randomUUID()}`, grantId, revokedBy, reason, timestamp]
      );
      return { ...updated.rows[0], duplicate: false };
    });
  }
  // --- Audit-atomic variants -----------------------------------------
  // Each of these wraps its mutation and its audit_events insert in the
  // same withTransaction() call, using the same client for both, so a
  // failure writing the audit row rolls back the mutation instead of
  // leaving an unaudited state change committed. Idempotent-replay
  // detection is unchanged from the standalone method: a replay never
  // performs the mutation and never writes a second audit row, so it
  // doesn't need the transaction at all beyond the read-modify check.
  async revokeOidcIdentityWithAudit(issuer, subject, { now = new Date(), actorHumanId = null, endpointId = null } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE oidc_identities SET status = 'revoked' WHERE issuer = $1 AND subject = $2 AND status <> 'revoked'
         RETURNING issuer, subject, human_id, status, created_at`,
        [issuer, subject]
      );
      if (!updated.rows[0]) {
        const existing = await client.query('SELECT issuer, subject, human_id, status, created_at FROM oidc_identities WHERE issuer = $1 AND subject = $2', [issuer, subject]);
        if (!existing.rows[0]) throw Object.assign(new Error('OIDC identity not found'), { code: 'IDENTITY_UNAVAILABLE' });
        return { ...existing.rows[0], duplicate: true };
      }
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, endpoint_id, object_type, object_id, outcome, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [`audit_${crypto.randomUUID()}`, 'oidc_identity.revoked', `${issuer}|${subject}`, actorHumanId, endpointId, 'oidc_identity', subject, 'success', timestamp]
      );
      return { ...updated.rows[0], duplicate: false };
    });
  }
  async unlinkAccountWithAudit(linkId, { now = new Date(), actorHumanId = null, endpointId = null } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const current = await client.query('SELECT * FROM account_links WHERE link_id = $1 FOR UPDATE', [linkId]);
      const link = current.rows[0];
      if (!link) throw Object.assign(new Error('Account link not found'), { code: 'LINK_UNAVAILABLE' });
      if (link.status === 'unlinked') return { ...link, duplicate: true };
      const remaining = await client.query(
        `SELECT
           (SELECT count(*) FROM account_links WHERE human_id = $1 AND status = 'active' AND link_id <> $2) AS other_links,
           (SELECT count(*) FROM human_credentials WHERE human_id = $1 AND status = 'active') AS credentials`,
        [link.human_id, linkId]
      );
      const { other_links: otherLinks, credentials } = remaining.rows[0];
      if (Number(otherLinks) === 0 && Number(credentials) === 0) {
        throw Object.assign(new Error('Unlinking would leave no recoverable authentication method'), { code: 'LOCKOUT_REFUSED' });
      }
      const updated = await client.query(
        `UPDATE account_links SET status = 'unlinked' WHERE link_id = $1 RETURNING link_id, human_id, issuer, subject, status, created_at`,
        [linkId]
      );
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, endpoint_id, object_type, object_id, outcome, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [`audit_${crypto.randomUUID()}`, 'account_link.unlinked', linkId, actorHumanId, endpointId, 'account_link', linkId, 'success', timestamp]
      );
      return { ...updated.rows[0], duplicate: false };
    });
  }
  async revokeHumanSessionWithAudit(sessionId, { now = new Date(), actorHumanId = null, endpointId = null } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE human_sessions SET revoked_at = $1 WHERE session_id = $2 AND revoked_at IS NULL
         RETURNING session_id, human_id, authentication_method, assurance, device_context, issued_at, version, expires_at, revoked_at`,
        [timestamp, sessionId]
      );
      if (!updated.rows[0]) {
        const existing = await client.query('SELECT * FROM human_sessions WHERE session_id = $1', [sessionId]);
        if (!existing.rows[0]) throw Object.assign(new Error('Session not found'), { code: 'SESSION_UNAVAILABLE' });
        return { ...existing.rows[0], duplicate: true };
      }
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, endpoint_id, object_type, object_id, outcome, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [`audit_${crypto.randomUUID()}`, 'human_session.revoked', sessionId, actorHumanId, endpointId, 'human_session', sessionId, 'success', timestamp]
      );
      return { ...updated.rows[0], duplicate: false };
    });
  }
  async createCapabilityGrantWithAudit({ grantId, subject, capability, scope, purpose, provenance, issuer, grantedTo, grantedBy, now = new Date(), expiresAt, actorHumanId = null, endpointId = null } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const expires = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt).toISOString();
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO capability_grants (grant_id, capability, scope, granted_to, granted_by, granted_at, expires_at, subject, purpose, provenance, issuer, issued_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $6)
         RETURNING grant_id, capability, scope, granted_to, granted_by, granted_at, expires_at, subject, purpose, provenance, issuer, issued_at, revoked_at`,
        [grantId, capability, scope, grantedTo, grantedBy, timestamp, expires, subject ?? grantedTo, purpose ?? null, provenance ?? null, issuer ?? null]
      );
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, endpoint_id, object_type, object_id, outcome, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [`audit_${crypto.randomUUID()}`, 'capability_grant.created', grantId, actorHumanId, endpointId ?? grantedTo, 'capability_grant', grantId, 'success', timestamp]
      );
      return result.rows[0];
    });
  }
  async revokeCapabilityGrantWithAudit(grantId, { revokedBy, reason, now = new Date(), actorHumanId = null, endpointId = null } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE capability_grants SET revoked_at = $1 WHERE grant_id = $2 AND revoked_at IS NULL
         RETURNING grant_id, capability, scope, granted_to, granted_by, granted_at, expires_at, subject, purpose, provenance, issuer, issued_at, revoked_at`,
        [timestamp, grantId]
      );
      if (!updated.rows[0]) {
        const existing = await client.query('SELECT * FROM capability_grants WHERE grant_id = $1', [grantId]);
        if (!existing.rows[0]) throw Object.assign(new Error('Capability grant not found'), { code: 'GRANT_UNAVAILABLE' });
        return { ...existing.rows[0], duplicate: true };
      }
      await client.query(
        `INSERT INTO capability_revocations (revocation_id, capability_grant_id, revoked_by, reason, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [`revocation_${crypto.randomUUID()}`, grantId, revokedBy, reason, timestamp]
      );
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, endpoint_id, object_type, object_id, outcome, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [`audit_${crypto.randomUUID()}`, 'capability_grant.revoked', grantId, actorHumanId, endpointId, 'capability_grant', grantId, 'success', reason ?? null, timestamp]
      );
      return { ...updated.rows[0], duplicate: false };
    });
  }
  async recordAuditEvent({ eventId = `audit_${crypto.randomUUID()}`, eventType, subjectId, actorId = null, actorHumanId = null, endpointId = null, objectType = null, objectId = null, actionHash = null, outcome = null, reason = null, payload = {}, metadataRedacted = null, now = new Date(), client = this.pool } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const result = await client.query(
      `INSERT INTO audit_events (event_id, event_type, subject_id, actor_id, actor_human_id, endpoint_id, object_type, object_id, action_hash, outcome, reason, payload, metadata_redacted, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING event_id, event_type, subject_id, actor_id, actor_human_id, endpoint_id, object_type, object_id, action_hash, outcome, reason, created_at`,
      [eventId, eventType, subjectId, actorId, actorHumanId, endpointId, objectType, objectId, actionHash, outcome, reason, JSON.stringify(payload), metadataRedacted ? JSON.stringify(metadataRedacted) : null, timestamp]
    );
    return result.rows[0];
  }
  // Replay guard shared by POST /v1/auth/mock-login and POST /v1/auth/login:
  // the primary-key uniqueness constraint on login_jti_replays.jti makes a
  // second insert of the same jti fail with 23505, mapped here to
  // TOKEN_REPLAYED.
  async consumeLoginJti(jti, { now = new Date(), expiresAt, client = this.pool } = {}) {
    const expires = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt).toISOString();
    try {
      await client.query('INSERT INTO login_jti_replays (jti, expires_at) VALUES ($1, $2)', [jti, expires]);
    } catch (error) {
      if (error.code === '23505') throw Object.assign(new Error('ID token has already been used'), { code: 'TOKEN_REPLAYED' });
      throw error;
    }
  }
  // Scoped strictly to enableMockOidc's opt-in startup path (Task 7) -- a
  // production relay that never sets --enable-mock-oidc never touches this
  // table for the fixture issuer.
  async upsertMockOidcIssuerAllowlist({ issuer, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    await this.pool.query(
      `INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, assurance_level, added_at)
       VALUES ($1, 'Mock OIDC (dev/test only)', TRUE, 'standard', $2)
       ON CONFLICT (issuer) DO UPDATE SET enabled = TRUE, assurance_level = 'standard'`,
      [issuer, timestamp]
    );
  }
  async getOidcIssuerAllowlistEntry(issuer) {
    const result = await this.pool.query('SELECT issuer, client_id, enabled FROM oidc_issuer_allowlist WHERE issuer = $1', [issuer]);
    const row = result.rows[0];
    if (!row) return null;
    return { issuer: row.issuer, clientId: row.client_id, enabled: row.enabled };
  }
  async listOidcIssuerAllowlist({ includeDisabled = false } = {}) {
    const result = await this.pool.query(
      `SELECT issuer, client_id, enabled, assurance_level FROM oidc_issuer_allowlist WHERE $1 OR enabled = TRUE`,
      [includeDisabled]
    );
    return result.rows.map((row) => ({ issuer: row.issuer, clientId: row.client_id, enabled: row.enabled, assuranceLevel: row.assurance_level }));
  }
  async upsertOidcIssuerAllowlist({ issuer, clientId, displayLabel = issuer, assuranceLevel = 'standard', enabled = true, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    await this.pool.query(
      `INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, assurance_level, client_id, added_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (issuer) DO UPDATE SET display_label = $2, enabled = $3, assurance_level = $4, client_id = $5`,
      [issuer, displayLabel, enabled, assuranceLevel, clientId, timestamp]
    );
  }
  // User explicitly chose soft-disable over hard delete -- re-adding goes
  // back through upsertOidcIssuerAllowlist's existing upsert.
  async disableOidcIssuerAllowlist(issuer) {
    await this.pool.query('UPDATE oidc_issuer_allowlist SET enabled = FALSE WHERE issuer = $1', [issuer]);
  }
  async upsertPeer({ domain, relayUrl, wsUrl = null, keys, trustMode, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const result = await this.pool.query(
      `INSERT INTO peer_relays (domain, relay_url, ws_url, keys, trust_mode, discovered_at, updated_at, last_resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6)
       ON CONFLICT (domain) DO UPDATE SET relay_url = $2, ws_url = $3, keys = $4, trust_mode = $5, updated_at = $6, last_resolved_at = $6
       RETURNING domain, relay_url, ws_url, keys, trust_mode, discovered_at, updated_at, last_resolved_at`,
      [domain, relayUrl, wsUrl, JSON.stringify(keys), trustMode, timestamp]
    );
    return rowToPeerRecord(result.rows[0]);
  }
  async getPeerByDomain(domain) {
    const result = await this.pool.query(
      'SELECT domain, relay_url, ws_url, keys, trust_mode, discovered_at, updated_at, last_resolved_at FROM peer_relays WHERE domain = $1',
      [domain]
    );
    return result.rows[0] ? rowToPeerRecord(result.rows[0]) : null;
  }
  async listPeers() {
    const result = await this.pool.query(
      'SELECT domain, relay_url, ws_url, keys, trust_mode, discovered_at, updated_at, last_resolved_at FROM peer_relays ORDER BY domain'
    );
    return result.rows.map(rowToPeerRecord);
  }
  async removePeer(domain) {
    const result = await this.pool.query('DELETE FROM peer_relays WHERE domain = $1', [domain]);
    return result.rowCount > 0;
  }
  async isConversationMember(endpointId, conversationId, client = this.pool) {
    const result = await client.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND endpoint_id = $2 AND removed_at IS NULL',
      [conversationId, endpointId]
    );
    return result.rows.length > 0;
  }
  async listAuditEventsForConversation(conversationId, client = this.pool) {
    const result = await client.query(
      'SELECT event_id, event_type, subject_id, actor_id, actor_human_id, endpoint_id, object_type, object_id, outcome, reason, created_at FROM audit_events WHERE conversation_id = $1 ORDER BY created_at',
      [conversationId]
    );
    return result.rows;
  }
  async close() { await this.pool.end(); }
}
