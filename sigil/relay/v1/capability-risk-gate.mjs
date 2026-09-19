import crypto from 'node:crypto';
import { signedBytes, reject } from './validate-envelope.mjs';

// Capability-registry + risk-tier + human-approval gate (design §7/§9),
// shared by every envelope-accept entry point so a 'high' risk_tier
// capability requires a matching, unconsumed approval decision no matter
// which path an envelope takes -- local delivery, sync/queue federation
// forward (accept-envelope.mjs), or federated inbound accept
// (accept-federated-envelope.mjs). Before this extraction the gate only
// ran on the local-delivery branch, silently skipping forwarded and
// inbound-federated envelopes (the federation approval-bypass fixed by
// this plan).
//
// `client` is optional and intentionally left undefined by default: the
// two repository calls below (`lookupCapabilityRegistration`,
// `consumeApprovalDecision`) both default their own `client` parameter to
// `this.pool` when called with `undefined`, so a caller with no open
// transaction (accept-envelope.mjs's Phase 1 sync-forward path, which must
// never hold a Postgres connection open across the outbound `postForward`
// network call) gets a plain pool checkout per call instead of forcing a
// transaction into existence. A caller that already has an open
// transaction (Phase 2 local/queue-forward, or accept-federated-envelope's
// inbound transaction) MUST pass that transaction's `client` explicitly so
// the approval-decision consumption commits or rolls back atomically with
// the rest of the accept.
export async function enforceCapabilityRiskGate(envelope, repository, { client, now = new Date() } = {}) {
  const highRiskCapabilities = [];
  for (const capability of envelope.capabilities ?? []) {
    const registration = await repository.lookupCapabilityRegistration(capability, client);
    if (!registration) throw reject('CAPABILITY_DENIED', `Capability is not registered: ${capability}`, { capability });
    if (registration.risk_tier === 'high') highRiskCapabilities.push(capability);
  }
  if (highRiskCapabilities.length) {
    const canonicalHash = crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex');
    const consumed = repository.consumeApprovalDecision
      ? await repository.consumeApprovalDecision({ endpointId: envelope.sender.endpoint_id, actionHash: canonicalHash, now, client })
      : null;
    if (!consumed) {
      throw reject('APPROVAL_REQUIRED', 'A valid decision record is required before delivery for high-risk capabilities', { capabilities: highRiskCapabilities });
    }
  }
  return highRiskCapabilities;
}
