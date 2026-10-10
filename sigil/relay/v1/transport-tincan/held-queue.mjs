import crypto from 'node:crypto';
import { signedBytes } from '../validate-envelope.mjs';

export function canonicalEnvelopeHash(envelope) {
  return crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex');
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export function createHeldQueue({ callbackUrl, submitChallengeFn }) {
  const held = new Map();
  return {
    async holdForApproval(envelope, token) {
      const frozen = deepFreeze(structuredClone(envelope));
      const actionHash = canonicalEnvelopeHash(frozen);
      held.set(actionHash, frozen);
      const resolvedCallback = typeof callbackUrl === 'function' ? callbackUrl() : callbackUrl;
      const challenge = await submitChallengeFn({ action_hash: actionHash, callback_url: resolvedCallback }, token);
      return { actionHash, challengeId: challenge.challenge_id };
    },
    releaseEnvelope(actionHash) {
      const envelope = held.get(actionHash);
      if (!envelope) throw new Error(`Held envelope not found for ${actionHash}`);
      held.delete(actionHash);
      return envelope;
    },
  };
}
