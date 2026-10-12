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
