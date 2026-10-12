import crypto from 'node:crypto';
import { identityKeys as defaultIdentityKeys } from '../../cli/identity.mjs';
import { unwrapPrivateKey } from './key-wrap.mjs';

const spki = (key) => key.export({ type: 'spki', format: 'der' });

// signForEndpoint is the only place key material is read. The operator endpoint
// signs from the identity file; any other human endpoint signs with the
// relay-custodial key in human_signing_keys. Trust state is re-read on every
// call so a revoked endpoint stops signing at once; only the key comparison is
// memoized. Errors name endpoint ids, never key material.
export function createRoomHumanSigner({ identity, repository, wrapKey, identityKeys = defaultIdentityKeys }) {
  const keys = identityKeys(identity);
  const checked = new Set();
  const endpoint = { owner_id: identity.owner_id, endpoint_id: identity.endpoint_id, key_id: identity.key_id, kind: 'human' };
  return {
    endpointId: identity.endpoint_id,
    ownerId: identity.owner_id,
    // Checking only `kind` is not enough: Postgres rows default to agent, so
    // compare the public key the registry holds too.
    async verifyOperator() {
      const entry = await repository.lookupTrustedEndpoint(identity.endpoint_id);
      if (!entry || entry.status !== 'active' || entry.kind !== 'human') {
        throw Object.assign(new Error(`room human identity endpoint "${identity.endpoint_id}" is not an active human endpoint`), { code: 'ROOM_HUMAN_ENDPOINT_UNKNOWN' });
      }
      const key = entry.keys.get(identity.key_id);
      if (!key || !spki(key.public_key).equals(spki(keys.publicKey))) {
        throw Object.assign(new Error(`room human identity key does not match the registry key for "${identity.endpoint_id}"`), { code: 'ROOM_HUMAN_KEY_MISMATCH' });
      }
    },
    async signForEndpoint(endpointId) {
      if (endpointId === identity.endpoint_id) return { privateKey: keys.privateKey, endpoint };
      const entry = await repository.lookupTrustedEndpoint(endpointId);
      const active = entry && entry.status === 'active' && entry.kind === 'human'
        ? [...entry.keys.values()].find((k) => k.status === 'active')
        : null;
      const wrapped = active ? await repository.loadWrappedSigningKey(active.key_id) : null;
      if (!wrapped) throw Object.assign(new Error(`no signing key for endpoint "${endpointId}"`), { code: 'NO_SIGNING_KEY' });
      if (!wrapKey) throw Object.assign(new Error(`no wrap key configured to sign for endpoint "${endpointId}"`), { code: 'WRAP_KEY_UNAVAILABLE' });
      const privateKey = unwrapPrivateKey({ wrapKey, endpointId, keyId: active.key_id, wrapped });
      const memo = `${endpointId}:${active.key_id}`;
      if (!checked.has(memo)) {
        if (!spki(crypto.createPublicKey(privateKey)).equals(spki(active.public_key))) {
          throw Object.assign(new Error(`stored signing key does not match the registered key for endpoint "${endpointId}"`), { code: 'KEY_MISMATCH' });
        }
        checked.add(memo);
      }
      return { privateKey, endpoint: { owner_id: entry.owner_id, endpoint_id: endpointId, key_id: active.key_id, kind: 'human' } };
    },
  };
}
