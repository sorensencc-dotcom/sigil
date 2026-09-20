import { authorizeAgentMailControl } from './agentmail-control-policy.mjs';
import { buildAgentMailSecretSnapshot } from './agentmail-secret-snapshot.mjs';

function fail(code, message, details = {}) { throw Object.assign(new Error(message), { code, details }); }

export async function rotateAgentMailSecrets({ control, secretStore, resolver, providerRotation, config, actor, target = 'all', expectedControlVersion, requestId, reason, clock = () => new Date(), authorize = authorizeAgentMailControl, drainTimeoutMs = 30_000, audit } = {}) {
  const request = { requestId, reason, target };
  await authorize({ repository: control.repository ?? control, actor, action: 'rotate', request, clock });
  const ownerId = requestId ?? `${actor?.endpointId ?? actor?.endpoint_id ?? 'operator'}:${Date.now()}`;
  let drained;
  try {
    await control.acquireLease({ ownerId, ttlMs: drainTimeoutMs });
    const current = secretStore.current();
    drained = await control.transition({ action: 'drain', expectedVersion: expectedControlVersion, actorId: actor?.endpointId ?? actor?.endpoint_id, requestId, reason });
    if (typeof control.waitForIdle === 'function') await control.waitForIdle({ timeoutMs: drainTimeoutMs });
    const candidate = await buildAgentMailSecretSnapshot({ config, resolver, previous: current, generation: `gen_${new Date(clock()).getTime()}`, clock });
    if (typeof providerRotation?.rotate !== 'function') fail('PROVIDER_ROTATION_UNSUPPORTED', 'AgentMail provider rotation is not configured');
    const providerResult = await providerRotation.rotate({ target, currentSnapshot: current, candidateSnapshot: candidate });
    if (!providerResult?.supported || !providerResult?.committed) fail('PROVIDER_ROTATION_UNSUPPORTED', 'AgentMail provider cannot commit rotation');
    secretStore.swap(candidate, { expectedGeneration: current.generation });
    const resumed = await control.transition({ action: 'resume', expectedVersion: drained.version, snapshotGeneration: candidate.generation, actorId: actor?.endpointId ?? actor?.endpoint_id, requestId, reason });
    const receipt = { target, generation: candidate.generation, provider: providerResult.receipt ?? null, controlVersion: resumed.version };
    await audit?.({ eventType: 'agentmail.secret_rotated', actor, requestId, target, receipt, reason, now: clock() });
    return Object.freeze({ generation: candidate.generation, control: resumed, receipt });
  } catch (error) {
    try { await control.transition({ action: 'emergency_stop', expectedVersion: drained?.version, actorId: actor?.endpointId ?? actor?.endpoint_id, requestId, reason: 'rotation failed' }); } catch {}
    throw error?.code ? error : Object.assign(new Error('AgentMail secret rotation failed'), { code: 'SECRET_ROTATION_CONFLICT' });
  } finally {
    try { await control.releaseLease({ ownerId }); } catch {}
  }
}

export function createAgentMailControlHandler({ control, rotation, authorize } = {}) {
  return async function handle(request = {}, actor) {
    const allowed = new Set(['action', 'target', 'expectedVersion', 'requestId', 'reason']);
    if (Object.keys(request).some((key) => !allowed.has(key))) throw Object.assign(new Error('Control request contains unsupported fields'), { code: 'CONTROL_REQUEST_INVALID' });
    if (!request.action || !request.requestId) throw Object.assign(new Error('Control action and requestId are required'), { code: 'CONTROL_REQUEST_INVALID' });
    if (request.action === 'rotate') return rotation({ ...request, actor });
    await (authorize ?? authorizeAgentMailControl)({ repository: control.repository ?? control, actor, action: request.action, request, clock: control.clock });
    return control.transition({ action: request.action, expectedVersion: request.expectedVersion, actorId: actor?.endpointId ?? actor?.endpoint_id, requestId: request.requestId, reason: request.reason, snapshotGeneration: request.snapshotGeneration });
  };
}
