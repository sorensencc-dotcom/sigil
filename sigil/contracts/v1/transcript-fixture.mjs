// Test-only fixture builder for transcript verification tests (issue #295).
import crypto from 'node:crypto';
import { canonicalJson } from '../../relay/v1/jcs.mjs';
import { bytesToBase64url } from './transcript-verify.mjs';

const ROOM = 'room_test';

export function makeFixture({ count = 4, withCanonicalBytes = true } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keys = [{
    endpoint_id: 'ep_a', key_id: 'key_1',
    public_key_spki: bytesToBase64url(publicKey.export({ type: 'spki', format: 'der' })),
    status: 'active', valid_from: '2026-01-01T00:00:00.000Z', valid_until: null,
  }];
  const entries = [];
  for (let n = 1; n <= count; n += 1) {
    const unsigned = {
      protocol: 'sigil/1', message_id: `msg_${n}`, conversation_id: ROOM, message_type: 'room.message',
      sender: { endpoint_id: 'ep_a', owner_id: 'owner_a' }, body: { text: `hello ${n}` },
      context_refs: [], capabilities: [], idempotency_key: `idem_${n}`,
      created_at: '2026-11-01T00:00:00.000Z', expires_at: '2026-11-01T01:00:00.000Z',
    };
    const bytes = Buffer.from(canonicalJson(unsigned), 'utf8');
    const value = crypto.sign(null, bytes, privateKey).toString('base64url');
    entries.push({
      room_seq: String(n), message_id: `msg_${n}`,
      canonical_bytes: withCanonicalBytes ? bytes.toString('base64url') : null,
      envelope: { ...unsigned, signature: { algorithm: 'Ed25519', key_id: 'key_1', value } },
    });
  }
  return {
    format: 'sigil.room-transcript', version: 1, room_id: ROOM, exported_at: '2026-11-23T00:00:00.000Z',
    first_seq: '1', last_seq: String(count), count, keys, entries,
  };
}
