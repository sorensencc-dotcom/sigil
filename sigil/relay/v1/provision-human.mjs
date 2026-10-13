import crypto from 'node:crypto';
import { wrapPrivateKey } from './key-wrap.mjs';

const hex = (prefix) => `${prefix}${crypto.randomBytes(16).toString('hex')}`;

async function insertHumanAttribute(client, humanId, attr, ts) {
  if (attr.value === null || attr.value === undefined) {
    throw Object.assign(new Error(`attribute ${attr.kind ?? 'name'} requires a value`), { code: 'INVALID_ATTRIBUTE' });
  }
  // Provisioning never vouches for an attribute, whatever the caller passes.
  await client.query(
    `INSERT INTO human_attributes (attribute_id, human_id, kind, value_or_ciphertext, verification_state, source, observed_at, created_at)
     VALUES ($1,$2,$3,$4,'unverified',$5,$6,$6)`,
    [`attr_${crypto.randomUUID()}`, humanId, attr.kind ?? 'name', Buffer.from(String(attr.value), 'utf8'), attr.source ?? 'cli', ts],
  );
}

export async function provisionHumanTx(client, { displayName, attributes = [], wrapKey, now = new Date() } = {}) {
  if (!wrapKey) throw Object.assign(new Error('wrap key is required'), { code: 'WRAP_KEY_UNAVAILABLE' });
  const ts = (now instanceof Date ? now : new Date(now)).toISOString();
  const humanId = hex('hum_');
  const endpointId = hex('ep_');
  const keyId = hex('key_');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  await client.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1,'active',$2)`, [humanId, ts]);
  await client.query(
    `INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at)
     VALUES ($1,$2,'human','human',$3,$4,'active',$5)`,
    [endpointId, humanId, `install_${endpointId}`, displayName || endpointId, ts],
  );
  await client.query(
    `INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ($1,$2,'Ed25519',$3,'active',$4)`,
    [keyId, endpointId, publicKey.export({ type: 'spki', format: 'der' }), ts],
  );
  await client.query(
    `INSERT INTO human_signing_keys (key_id, wrapped_private_key, created_at) VALUES ($1,$2,$3)`,
    [keyId, wrapPrivateKey({ wrapKey, endpointId, keyId, privateKey }), ts],
  );
  for (const attr of attributes) await insertHumanAttribute(client, humanId, attr, ts);
  await client.query(
    `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, object_type, object_id, outcome, created_at)
     VALUES ($1,'human.provisioned',$2,NULL,'human',$2,'success',$3)`,
    [`audit_${crypto.randomUUID()}`, humanId, ts],
  );
  return { human_id: humanId, endpoint_id: endpointId, key_id: keyId };
}

// Locks the human's active rows and, when given, the target endpoint's row in
// the same rooms (removed or not, since a restore updates it) in one sorted
// statement, so two actors adding each other cannot lock in opposite orders.
export async function lockManagerRows(client, humanId, roomIds, targetEndpointId = null) {
  const { rows } = await client.query(
    `SELECT m.*, e.owner_id FROM conversation_members m JOIN endpoints e ON e.endpoint_id = m.endpoint_id
      WHERE m.conversation_id = ANY($2)
        AND ((e.owner_id = $1 AND m.removed_at IS NULL) OR m.endpoint_id = $3)
      ORDER BY m.conversation_id, m.endpoint_id FOR UPDATE OF m`, [humanId, roomIds, targetEndpointId]);
  return rows;
}

const MANAGER = new Set(['owner', 'room_manager']);
const GRANTABLE = new Set(['member', 'room_manager']);

// Rooms are locked in sorted order and members inserted in sorted order, so
// concurrent calls naming the same rooms in different orders cannot deadlock.
export async function addHumanToRoomsTx(client, { endpointId, memberships, actorHumanId, repository, now = new Date() }) {
  for (const { role } of memberships) {
    if (!GRANTABLE.has(role)) throw Object.assign(new Error('role must be member or room_manager'), { code: 'INVALID_ROLE' });
  }
  const roomIds = [...new Set(memberships.map((m) => m.roomId))].sort();
  const locked = await lockManagerRows(client, actorHumanId, roomIds, endpointId);
  const managed = new Set(locked.filter((r) => r.owner_id === actorHumanId && r.removed_at === null && MANAGER.has(r.role)).map((r) => r.conversation_id));
  const missing = roomIds.filter((id) => !managed.has(id));
  if (missing.length) throw Object.assign(new Error(`actor does not manage: ${missing.join(', ')}`), { code: 'ROUTE_NOT_AUTHORIZED', rooms: missing });
  const target = await repository.lookupTrustedEndpoint(endpointId, client);
  if (!target || target.status !== 'active' || target.kind !== 'human') {
    throw Object.assign(new Error('target is not an active human endpoint'), { code: 'ROUTE_NOT_AUTHORIZED' });
  }
  for (const { roomId, role } of [...memberships].sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0))) {
    try {
      await repository.addRoomMember({ conversationId: roomId, endpointId, role, addedByHumanId: actorHumanId, now }, client);
    } catch (error) {
      if (error.code !== 'ROOM_MEMBER_EXISTS') throw error;
    }
  }
  return { room_ids: roomIds };
}
