// OAuth callback decision (spec "Callback decision"). One transaction per
// callback, opened after the provider calls finish:
//   1. a verified (verified_via = 'oauth') identity row: returning login,
//      reactivation through a pinned targeted invite, or denied;
//   2. no verified row and a usable invite: link and log in;
//   3. otherwise invite_required.
// Lock order matches the foundation: identity row, then invite, then the
// creator's membership rows (sorted), then humans -> endpoints FOR SHARE.
import crypto from 'node:crypto';
import { provisionHumanTx, addHumanToRoomsTx, lockManagerRows } from '../provision-human.mjs';
import { hashInviteToken } from './invites.mjs';

export const SESSION_ABSOLUTE_MS = 7 * 24 * 3600_000;
const MANAGER = new Set(['owner', 'room_manager']);
const GITHUB_ISSUER = 'https://github.com';

const audit = (client, { type, subjectId, actorHumanId = null, objectType = null, objectId = null, outcome = 'success', now }) =>
  client.query(
    `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, object_type, object_id, outcome, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [`audit_${crypto.randomUUID()}`, type, subjectId, actorHumanId, objectType, objectId, outcome, now.toISOString()]);

class Abort extends Error {
  constructor(outcome, humanId = null) { super(outcome); this.outcome = outcome; this.humanId = humanId; }
}

// Spec linking step 1: the row lock serializes two redemptions of one invite
// and a revoke against a redeem; the loser re-evaluates the WHERE and aborts.
async function lockInvite(client, tokenHash, now) {
  const { rows } = await client.query(
    `SELECT * FROM room_invites WHERE token_hash = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > $2 FOR UPDATE`,
    [tokenHash, now.toISOString()]);
  if (!rows[0]) throw new Abort('invite_expired');
  const { rows: rooms } = await client.query(`SELECT room_id, role FROM room_invite_rooms WHERE invite_id = $1 ORDER BY room_id`, [rows[0].invite_id]);
  return { invite: rows[0], rooms: rooms.map((r) => ({ roomId: r.room_id, role: r.role })) };
}

// Spec linking step 2: lock the creator's membership rows in sorted order and
// require them to still manage every invite room.
async function recheckCreator(client, invite, rooms) {
  if (!rooms.length) return;
  const roomIds = rooms.map((r) => r.roomId);
  const locked = await lockManagerRows(client, invite.created_by_human_id, roomIds);
  const managed = new Set(locked.filter((r) => r.owner_id === invite.created_by_human_id && r.removed_at === null && MANAGER.has(r.role)).map((r) => r.conversation_id));
  if (roomIds.some((id) => !managed.has(id))) throw new Abort('invite_expired');
}

// Takes human then endpoint FOR SHARE (suspension updates humans first), and
// requires both active and the endpoint a human endpoint owned by the human.
async function lockActiveHumanEndpoint(client, humanId, endpointId) {
  const h = await client.query(`SELECT status FROM humans WHERE human_id = $1 FOR SHARE`, [humanId]);
  const e = await client.query(`SELECT status, kind, owner_id FROM endpoints WHERE endpoint_id = $1 FOR SHARE`, [endpointId]);
  return h.rows[0]?.status === 'active' && e.rows[0]?.status === 'active' && e.rows[0]?.kind === 'human' && e.rows[0]?.owner_id === humanId;
}

const pinMatches = (invite, identity) => invite.target_issuer === identity.issuer && invite.target_subject === identity.subject;

// addHumanToRoomsTx re-checks the creator itself; its refusal means the invite
// can no longer be honoured, which the callback reports as invite_expired.
async function addRooms(client, args) {
  try {
    await addHumanToRoomsTx(client, args);
  } catch (error) {
    if (error.code === 'ROUTE_NOT_AUTHORIZED') throw new Abort('invite_expired');
    throw error;
  }
}

export async function completeLogin({ repository, identity, inviteToken = null, flowId, sessionId, wrapKey, authenticationMethod = 'oauth_github', now = new Date() }) {
  const tokenHash = inviteToken ? hashInviteToken(inviteToken) : null;
  try {
    return await repository.withTransaction(async (client) => {
      const { rows: [row] } = await client.query(
        `SELECT * FROM oidc_identities WHERE issuer = $1 AND subject = $2 AND verified_via = 'oauth' FOR UPDATE`,
        [identity.issuer, identity.subject]);
      if (row) return existing(client, row);
      if (!tokenHash) throw new Abort('invite_required');
      return link(client);
    });
  } catch (error) {
    if (!(error instanceof Abort)) throw error;
    if (error.outcome !== 'denied') return { outcome: error.outcome, audit: null };
    // The decision rolled back; the denial is recorded on its own. Spec audit
    // rules: the human id when the identity matched a known human, otherwise
    // flow:<flow_id>, and never the provider subject or a hash of it. With no
    // flow id the callback cannot be attributed, so no row is written.
    const subjectId = error.humanId ?? (flowId ? `flow:${flowId}` : null);
    if (subjectId) {
      await repository.withTransaction((c) => audit(c, {
        type: 'oauth_login.denied', subjectId, actorHumanId: error.humanId, outcome: 'denied', now }));
    }
    return { outcome: 'denied', audit: subjectId ? { type: 'oauth_login.denied', subjectId } : null };
  }

  async function newSession(client, humanId, endpointId) {
    return repository.createHumanSession({
      sessionId, humanId, authenticationMethod, assurance: 'standard', issuedAt: now,
      expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS), now, client,
      endpointId, lastSeenAt: now, identityIssuer: identity.issuer, identitySubject: identity.subject,
    });
  }

  async function success(client, humanId, endpointId) {
    await audit(client, { type: 'oauth_login.success', subjectId: humanId, actorHumanId: humanId, now });
    return { outcome: 'login', human_id: humanId, endpoint_id: endpointId, audit: { type: 'oauth_login.success', subjectId: humanId } };
  }

  async function existing(client, row) {
    // A targeted invite aimed at a different human is denied whatever the
    // row's state, so an operator opening a guest's link is not logged in as
    // themselves. This read only decides; the invite is locked below if used.
    let targeted = null;
    if (tokenHash) {
      const { rows: [inv] } = await client.query(
        `SELECT * FROM room_invites WHERE token_hash = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > $2`,
        [tokenHash, now.toISOString()]);
      if (inv?.target_human_id && inv.target_human_id !== row.human_id) throw new Abort('denied', row.human_id);
      if (inv?.target_human_id) targeted = inv;
    }
    if (row.status === 'active') {
      if (!(await lockActiveHumanEndpoint(client, row.human_id, row.endpoint_id))) throw new Abort('denied', row.human_id);
      await newSession(client, row.human_id, row.endpoint_id);
      return success(client, row.human_id, row.endpoint_id);
    }
    if (row.status === 'revoked' && targeted && pinMatches(targeted, identity)) {
      // Reactivation transaction: linking steps 1 and 3 on the locked invite.
      const { invite, rooms } = await lockInvite(client, tokenHash, now);
      if (!(invite.target_human_id === row.human_id && pinMatches(invite, identity))) throw new Abort('denied', row.human_id);
      await recheckCreator(client, invite, rooms);
      if (!(await lockActiveHumanEndpoint(client, row.human_id, row.endpoint_id))) throw new Abort('denied', row.human_id);
      await client.query(`UPDATE oidc_identities SET status = 'active' WHERE issuer = $1 AND subject = $2`, [identity.issuer, identity.subject]);
      await newSession(client, row.human_id, row.endpoint_id);
      await consume(client, invite, row.human_id);
      // Spec audit rules: oidc_identity.reactivated uses <issuer>|<subject>,
      // the convention of the existing audited identity revoke.
      await audit(client, { type: 'oidc_identity.reactivated', subjectId: `${identity.issuer}|${identity.subject}`, actorHumanId: row.human_id, objectType: 'room_invite', objectId: invite.invite_id, now });
      return success(client, row.human_id, row.endpoint_id);
    }
    throw new Abort('denied', row.human_id);
  }

  async function link(client) {
    const { invite, rooms } = await lockInvite(client, tokenHash, now);
    await recheckCreator(client, invite, rooms);
    let humanId; let endpointId;
    if (invite.target_human_id) {
      if (!pinMatches(invite, identity)) throw new Abort('denied');
      if (!(await lockActiveHumanEndpoint(client, invite.target_human_id, invite.target_endpoint_id))) throw new Abort('denied');
      humanId = invite.target_human_id; endpointId = invite.target_endpoint_id;
    } else {
      const attributes = [{ kind: 'name', value: invite.name, source: 'operator' }];
      if (identity.displayName) attributes.push({ kind: 'name', value: identity.displayName, source: identity.issuer === GITHUB_ISSUER ? 'github' : 'provider' });
      const provisioned = await provisionHumanTx(client, { displayName: invite.name, attributes, wrapKey, now });
      humanId = provisioned.human_id; endpointId = provisioned.endpoint_id;
    }
    if (rooms.length) await addRooms(client, { endpointId, memberships: rooms, actorHumanId: invite.created_by_human_id, repository, now });
    try {
      await repository.createOidcIdentity({ issuer: identity.issuer, subject: identity.subject, humanId, now, client, verifiedVia: 'oauth', endpointId });
    } catch (error) {
      // An unverified row already holds the (issuer, subject) primary key.
      if (error.code === '23505' && error.constraint === 'oidc_identities_pkey') throw new Abort('denied');
      throw error;
    }
    await newSession(client, humanId, endpointId);
    await consume(client, invite, humanId);
    await audit(client, { type: 'invite.redeemed', subjectId: humanId, actorHumanId: humanId, objectType: 'room_invite', objectId: invite.invite_id, now });
    return success(client, humanId, endpointId);
  }

  async function consume(client, invite, humanId) {
    await client.query(`UPDATE room_invites SET consumed_at = $2, consumed_by_human_id = $3 WHERE invite_id = $1`, [invite.invite_id, now.toISOString(), humanId]);
  }
}
