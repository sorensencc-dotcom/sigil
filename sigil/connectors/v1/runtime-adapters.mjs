import { createHostAdapter } from './host-adapter.mjs';

const COMMON = ['checkInbox', 'getResult', 'requestApproval', 'resolveContext', 'ackDelivery'];

function createRuntimeAdapter({ connector, runtime, operations, packagePermissions, connectorGrants }) {
  if (!connector || typeof connector !== 'object') throw new Error('connector is required');
  for (const operation of operations) {
    if (typeof connector[operation] !== 'function') throw new Error(`connector.${operation} is required`);
  }
  return createHostAdapter({ connector, runtime, operations, packagePermissions, connectorGrants });
}

export function createCodexAdapter({ connector, packagePermissions, connectorGrants } = {}) {
  return createRuntimeAdapter({ connector, runtime: 'codex', operations: [...COMMON, 'sendTask'], packagePermissions, connectorGrants });
}

export function createClaudeAdapter({ connector, packagePermissions, connectorGrants } = {}) {
  return createRuntimeAdapter({ connector, runtime: 'claude', operations: [...COMMON, 'processTask', 'processDelivery', 'submitResult'], packagePermissions, connectorGrants });
}
