import crypto from 'node:crypto';
import { unwrapPrivateKey } from './key-wrap.mjs';

const spki = (key) => key.export({ type: 'spki', format: 'der' });

// Relay-held signing for Floor Warden bots. Reads bot_signing_keys only, never
// human_signing_keys. Trust state is re-read on every call so a revoked
// endpoint stops signing at once; only the public-key comparison is memoized.
// Errors name endpoint ids, never key material.
export function createRoomBotSigner({ repository, wrapKey }) {
  const checked = new Set();
  return {
    async signForBot(endpointId) {
      const entry = await repository.lookupTrustedEndpoint(endpointId);
      if (entry && entry.status !== 'active') {
        throw Object.assign(new Error(`endpoint "${endpointId}" is not active`), { code: 'ENDPOINT_REVOKED' });
      }
      const active = entry && entry.kind === 'agent'
        ? [...entry.keys.values()].find((k) => k.status === 'active')
        : null;
      const wrapped = active ? await repository.loadWrappedBotSigningKey(active.key_id) : null;
      if (!wrapped) throw Object.assign(new Error(`no signing key for endpoint "${endpointId}"`), { code: 'NO_SIGNING_KEY' });
      if (!wrapKey) throw Object.assign(new Error(`no wrap key configured to sign for endpoint "${endpointId}"`), { code: 'WRAP_KEY_UNAVAILABLE' });
      let privateKey;
      try {
        privateKey = unwrapPrivateKey({ wrapKey, endpointId, keyId: active.key_id, wrapped });
      } catch (cause) {
        throw Object.assign(new Error(`could not unwrap the signing key for endpoint "${endpointId}"`), { code: 'KEY_UNWRAP_FAILED', cause });
      }
      const memo = `${endpointId}:${active.key_id}`;
      if (!checked.has(memo)) {
        if (!spki(crypto.createPublicKey(privateKey)).equals(spki(active.public_key))) {
          throw Object.assign(new Error(`stored signing key does not match the registered key for endpoint "${endpointId}"`), { code: 'KEY_MISMATCH' });
        }
        checked.add(memo);
      }
      return { privateKey, endpoint: { owner_id: entry.owner_id, endpoint_id: endpointId, key_id: active.key_id, kind: 'agent' } };
    },
  };
}
