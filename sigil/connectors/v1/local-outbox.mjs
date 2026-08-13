import crypto from 'node:crypto';
import { signedBytes } from '../../relay/v1/validate-envelope.mjs';

export class LocalOutbox {
  #messages = new Map();

  constructor({ privateKey, endpoint }) {
    this.privateKey = privateKey;
    this.endpoint = endpoint;
  }

  queue(envelope) {
    if (!envelope?.message_id || !envelope.idempotency_key) throw Object.assign(new Error('message_id and idempotency_key are required'), { code: 'INVALID_ENVELOPE' });
    if (this.#messages.has(envelope.message_id)) return this.#messages.get(envelope.message_id);
    const signed = { ...envelope, sender: this.endpoint, signature: { algorithm: 'Ed25519', key_id: this.endpoint.key_id, value: '' } };
    signed.signature.value = crypto.sign(null, signedBytes(signed), this.privateKey).toString('base64url');
    this.#messages.set(signed.message_id, { envelope: signed, state: 'pending' });
    return this.#messages.get(signed.message_id);
  }

  markAccepted(messageId) {
    const item = this.#messages.get(messageId);
    if (!item) throw Object.assign(new Error('Message not found'), { code: 'CONTEXT_NOT_FOUND' });
    item.state = 'accepted';
    return item;
  }

  pending() { return [...this.#messages.values()].filter((item) => item.state === 'pending'); }
}
