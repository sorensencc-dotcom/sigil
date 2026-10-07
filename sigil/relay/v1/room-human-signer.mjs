import { identityKeys as defaultIdentityKeys } from '../../cli/identity.mjs';

const spki = (key) => key.export({ type: 'spki', format: 'der' });

// signForEndpoint is the only place key material is read. v1 holds one identity
// (single-owner localhost, same trust boundary as the CLI). Per-human keys are
// a later swap behind this same function. Checking only `kind` is not enough,
// because the registry defaults kind to human while Postgres rows default to
// agent; compare the public key the registry holds instead.
export function createRoomHumanSigner({ identity, registry, identityKeys = defaultIdentityKeys }) {
  const entry = registry?.get?.(identity.endpoint_id);
  if (!entry || entry.status !== 'active' || entry.kind === 'agent') {
    throw Object.assign(new Error(`room human identity endpoint "${identity.endpoint_id}" is not an active human endpoint in the registry`), { code: 'ROOM_HUMAN_ENDPOINT_UNKNOWN' });
  }
  const keys = identityKeys(identity);
  if (entry.key_id !== identity.key_id || !entry.public_key || !spki(entry.public_key).equals(spki(keys.publicKey))) {
    throw Object.assign(new Error(`room human identity key does not match the registry key for "${identity.endpoint_id}"`), { code: 'ROOM_HUMAN_KEY_MISMATCH' });
  }
  const endpoint = { owner_id: identity.owner_id, endpoint_id: identity.endpoint_id, key_id: identity.key_id, kind: identity.kind };
  return {
    endpointId: identity.endpoint_id,
    ownerId: identity.owner_id,
    signForEndpoint(endpointId) {
      if (endpointId !== identity.endpoint_id) throw Object.assign(new Error(`no signing key for endpoint "${endpointId}"`), { code: 'NO_SIGNING_KEY' });
      return { privateKey: keys.privateKey, endpoint };
    },
  };
}
