const STATES = new Set(['received', 'quarantined', 'accepted', 'dispatched', 'completed', 'rejected', 'dead_lettered']);
const TRANSITIONS = new Map([
  ['received', new Set(['quarantined', 'rejected', 'dead_lettered'])],
  ['quarantined', new Set(['accepted', 'rejected', 'dead_lettered'])],
  ['accepted', new Set(['dispatched', 'rejected', 'dead_lettered'])],
  ['dispatched', new Set(['completed', 'dead_lettered'])],
  ['completed', new Set()],
  ['rejected', new Set(['quarantined'])],
  ['dead_lettered', new Set(['quarantined'])],
]);

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function nowIso(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

export function createAgentMailLedger({ repository, clock = () => new Date(), maxQueueDepth = 100 } = {}) {
  const records = new Map();
  const workflowDepth = new Map();

  async function recordIngressEvent(input = {}) {
    for (const field of ['eventId', 'providerEventId', 'providerMessageId', 'inboxId', 'idempotencyKey']) if (typeof input[field] !== 'string' || input[field].trim() === '') fail('INVALID_INGRESS_EVENT', `${field} is required`, { field });
    if (repository?.query) {
      const result = await repository.query(
        `INSERT INTO agentmail_ingress_events
           (event_id, provider_event_id, provider_message_id, inbox_id, idempotency_key, state, provenance, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'received',$6,$7,$7)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING event_id, state`,
        [input.eventId, input.providerEventId, input.providerMessageId, input.inboxId, input.idempotencyKey, JSON.stringify(input.provenance ?? {}), nowIso(clock())],
      );
      if (result.rows[0]) return { ...result.rows[0], duplicate: false };
      const existing = await repository.query('SELECT event_id, state FROM agentmail_ingress_events WHERE idempotency_key = $1', [input.idempotencyKey]);
      return { ...(existing.rows[0] ?? { event_id: input.eventId, state: 'received' }), duplicate: true };
    }
    const existing = [...records.values()].find((record) => record.idempotencyKey === input.idempotencyKey);
    if (existing) return { eventId: existing.eventId, state: existing.state, duplicate: true };
    const workflow = input.workflow ?? input.provenance?.workflow ?? 'unclassified';
    if ((workflowDepth.get(workflow) ?? 0) >= maxQueueDepth) fail('QUEUE_SATURATED', 'Ingress workflow queue is saturated', { workflow });
    const record = { ...input, state: 'received', workflow, createdAt: nowIso(clock()), updatedAt: nowIso(clock()) };
    records.set(record.eventId, record);
    workflowDepth.set(workflow, (workflowDepth.get(workflow) ?? 0) + 1);
    return { eventId: record.eventId, state: record.state, duplicate: false };
  }

  async function transitionIngressState(eventId, nextState, { operatorApprovedReplay = false, rejectionCode = null, envelopeMessageId = null } = {}) {
    if (!STATES.has(nextState)) fail('INGRESS_STATE_INVALID', 'Unknown ingress state', { nextState });
    if (repository?.query) {
      const current = await repository.query('SELECT event_id, state FROM agentmail_ingress_events WHERE event_id = $1 FOR UPDATE', [eventId]);
      const row = current.rows[0];
      if (!row) fail('INGRESS_EVENT_NOT_FOUND', 'Ingress event not found');
      if (!TRANSITIONS.get(row.state)?.has(nextState)) fail(nextState === 'quarantined' && ['rejected', 'dead_lettered'].includes(row.state) ? 'INGRESS_REPLAY_APPROVAL_REQUIRED' : 'INGRESS_STATE_INVALID', 'Invalid ingress state transition');
      if (nextState === 'quarantined' && ['rejected', 'dead_lettered'].includes(row.state) && !operatorApprovedReplay) fail('INGRESS_REPLAY_APPROVAL_REQUIRED', 'Operator approval is required to replay an ingress event');
      const updated = await repository.query('UPDATE agentmail_ingress_events SET state = $2, rejection_code = $3, envelope_message_id = COALESCE($4, envelope_message_id), updated_at = $5 WHERE event_id = $1 RETURNING event_id, state, rejection_code, envelope_message_id', [eventId, nextState, rejectionCode, envelopeMessageId, nowIso(clock())]);
      return updated.rows[0];
    }
    const record = records.get(eventId);
    if (!record) fail('INGRESS_EVENT_NOT_FOUND', 'Ingress event not found');
    if (!TRANSITIONS.get(record.state)?.has(nextState)) fail(nextState === 'quarantined' && ['rejected', 'dead_lettered'].includes(record.state) ? 'INGRESS_REPLAY_APPROVAL_REQUIRED' : 'INGRESS_STATE_INVALID', 'Invalid ingress state transition');
    if (nextState === 'quarantined' && ['rejected', 'dead_lettered'].includes(record.state) && !operatorApprovedReplay) fail('INGRESS_REPLAY_APPROVAL_REQUIRED', 'Operator approval is required to replay an ingress event');
    record.state = nextState;
    record.rejectionCode = rejectionCode ?? record.rejectionCode ?? null;
    record.envelopeMessageId = envelopeMessageId ?? record.envelopeMessageId ?? null;
    record.updatedAt = nowIso(clock());
    return { eventId, state: record.state, rejectionCode: record.rejectionCode, envelopeMessageId: record.envelopeMessageId };
  }

  return { recordIngressEvent, transitionIngressState };
}

export { STATES, TRANSITIONS };
