const CAPABILITIES = Object.freeze({
  drain: 'sigil.agentmail/control_drain', disable: 'sigil.agentmail/control_disable', resume: 'sigil.agentmail/control_resume', rotate: 'sigil.agentmail/control_rotate', emergency_stop: 'sigil.agentmail/control_emergency_stop',
});

function fail(code, message, details = {}) { throw Object.assign(new Error(message), { code, details }); }

export async function authorizeAgentMailControl({ repository, actor = {}, action, request = {}, clock = () => new Date() } = {}) {
  const capability = CAPABILITIES[action];
  if (!capability) fail('CONTROL_ACTION_INVALID', 'AgentMail control action is invalid', { action });
  const endpointId = actor.endpointId ?? actor.endpoint_id;
  const registration = await repository?.lookupCapabilityRegistration?.(capability);
  if (!registration) fail('CONTROL_CAPABILITY_UNREGISTERED', 'AgentMail control capability is not registered', { action });
  if (typeof repository?.authorizeAgentMailControl === 'function') {
    const decision = await repository.authorizeAgentMailControl({ actor, action, request, capability, now: clock() });
    if (!decision?.allowed) fail('CONTROL_AUTHORIZATION_REQUIRED', 'AgentMail control authorization was denied', { action });
    return Object.freeze({ allowed: true, action, capability, endpointId: endpointId ?? null, riskTier: registration.risk_tier ?? registration.riskTier ?? null });
  }
  const grants = await repository?.lookupActiveCapabilityGrants?.(endpointId, clock()) ?? [];
  const grant = grants.find((entry) => (entry.capability ?? entry.name) === capability);
  if (!grant) fail('CONTROL_AUTHORIZATION_REQUIRED', 'AgentMail control capability is not granted', { action });
  const highRisk = (registration.risk_tier ?? registration.riskTier) === 'high';
  if (highRisk && request.approvalDecision?.approved !== true) {
    const approval = await repository?.checkApprovalDecision?.({ actor, action, request, now: clock() });
    if (approval?.approved !== true) fail('CONTROL_APPROVAL_REQUIRED', 'High-risk AgentMail control action requires approval', { action });
  }
  return Object.freeze({ allowed: true, action, capability, endpointId: endpointId ?? null, riskTier: registration.risk_tier ?? registration.riskTier ?? null });
}

export { CAPABILITIES };
