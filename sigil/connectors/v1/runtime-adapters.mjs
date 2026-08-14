import { createHostAdapter } from './host-adapter.mjs';

const COMMON = ['checkInbox', 'getResult', 'requestApproval', 'resolveContext'];

function createRuntimeAdapter({ connector, runtime, operations }) {
  if (!connector || typeof connector !== 'object') throw new Error('connector is required');
  for (const operation of operations) {
    if (typeof connector[operation] !== 'function') throw new Error(`connector.${operation} is required`);
  }
  return createHostAdapter({ connector, runtime, operations });
}

export function createCodexAdapter({ connector } = {}) {
  return createRuntimeAdapter({ connector, runtime: 'codex', operations: [...COMMON, 'sendTask'] });
}

export function createClaudeAdapter({ connector } = {}) {
  return createRuntimeAdapter({ connector, runtime: 'claude', operations: [...COMMON, 'processTask', 'processDelivery', 'submitResult'] });
}
