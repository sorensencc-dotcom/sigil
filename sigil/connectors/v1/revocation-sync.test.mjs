import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorDatabase } from './connector-db-adapter.mjs';
import { canonicalJsonBytes } from '../../relay/v1/jcs.mjs';
import { applySignedRevocationSync } from './revocation-sync.mjs';

function generateRelayKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey, privateKey };
}

function signManifest(manifestBody, privateKey, keyId = 'relay-key-1') {
  const bytes = canonicalJsonBytes(manifestBody);
  const signatureValue = crypto.sign(null, bytes, privateKey).toString('base64url');
  return {
    ...manifestBody,
    signature: {
      algorithm: 'Ed25519',
      key_id: keyId,
      value: signatureValue
    }
  };
}

test('applySignedRevocationSync validates manifest signature and atomically commits intervals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigil-sync-'));
  const db = new ConnectorDatabase(join(dir, 'connector.db'), new URL('./connector-schema.sql', import.meta.url));
  db.upsertProfile({ profile_id: 'prof_1', owner_id: 'u1', endpoint_id: 'ep_1', display_name: 'Ep 1', relay_url: 'ws://relay', secure_key_reference: 'k', secure_token_reference: 't' });

  const { publicKey, privateKey } = generateRelayKey();
  const manifest = signManifest({
    protocol: 'sigil/1',
    manifest_type: 'revocation_sync',
    relay_id: 'relay.example.com',
    sequence: 10,
    issued_at: '2026-08-28T12:00:00.000Z',
    revocations: [
      {
        revocation_event_id: 'rev_100',
        endpoint_id: 'ep_target@relay.example.com',
        key_id: 'key_target_1',
        revoked_at: '2026-08-28T11:00:00.000Z',
        reason: 'compromised',
        valid_from: '2026-08-01T00:00:00.000Z',
        valid_until: '2026-09-01T00:00:00.000Z'
      }
    ]
  }, privateKey);

  const res = applySignedRevocationSync({ db, profileId: 'prof_1', manifest, relayPublicKey: publicKey, lastSequence: 5 });
  assert.equal(res.appliedCount, 1);
  assert.equal(res.sequence, 10);

  const item = db.getRevocationInterval('prof_1', 'ep_target@relay.example.com', 'key_target_1');
  assert.equal(item.revocation_event_id, 'rev_100');

  // Out of order sequence must throw INVALID_SYNC_MANIFEST
  assert.throws(() => applySignedRevocationSync({ db, profileId: 'prof_1', manifest, relayPublicKey: publicKey, lastSequence: 10 }), { code: 'INVALID_SYNC_MANIFEST' });

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
