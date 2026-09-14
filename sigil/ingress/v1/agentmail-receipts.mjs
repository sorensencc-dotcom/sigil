import crypto from 'node:crypto';
import { signedBytes } from '../../relay/v1/validate-envelope.mjs';

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function emitIngressReceipt({ event, outcome, signer, createdAt = new Date().toISOString() } = {}) {
  if (!event?.eventId || !event?.correlationId) fail('INVALID_RECEIPT', 'Ingress event and correlation id are required');
  const keyId = signer?.keyId ?? signer?.key_id;
  const privateKey = signer?.privateKey ?? (signer?.private_key_pem ? crypto.createPrivateKey(signer.private_key_pem) : null);
  if (!keyId || !privateKey) fail('INVALID_RECEIPT', 'Receipt signer is required');
  const unsigned = {
    protocol: 'sigil/1',
    receipt_id: `receipt_${crypto.randomUUID()}`,
    event_id: event.eventId,
    correlation_id: event.correlationId,
    state: outcome?.state ?? 'unknown',
    rejection_code: outcome?.rejectionCode ?? null,
    created_at: createdAt,
  };
  return {
    ...unsigned,
    signature: { algorithm: 'Ed25519', key_id: keyId, value: crypto.sign(null, signedBytes(unsigned), privateKey).toString('base64url') },
  };
}
