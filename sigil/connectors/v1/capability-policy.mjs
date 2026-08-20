const OPERATION_CAPABILITIES = Object.freeze({
  sendTask: 'sigil.task/submit',
  checkInbox: 'sigil.task/read_inbox',
  getResult: 'sigil.task/read_result',
  ackDelivery: 'sigil.task/process',
  requestApproval: 'sigil.approval/request',
  resolveContext: 'sigil.core/read_shared_context',
  processTask: 'sigil.task/process',
  processDelivery: 'sigil.task/process',
  submitResult: 'sigil.task/submit_result'
});

function allows(grants, capability) {
  return grants.includes(capability) || grants.some((grant) => grant.endsWith('/*') && capability.startsWith(grant.slice(0, -1)));
}

export function capabilityForOperation(operation) {
  return OPERATION_CAPABILITIES[operation];
}

export function assertCapability(operation, { packagePermissions = [], connectorGrants = [] } = {}) {
  const capability = capabilityForOperation(operation);
  if (!capability) throw Object.assign(new Error(`Unknown connector operation: ${operation}`), { code: 'UNKNOWN_OPERATION' });
  if (!allows(packagePermissions, capability) || !allows(connectorGrants, capability)) {
    throw Object.assign(new Error(`Capability denied for ${operation}`), { code: 'CAPABILITY_DENIED', capability });
  }
  return capability;
}
