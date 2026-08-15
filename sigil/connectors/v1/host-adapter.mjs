import { assertCapability } from './capability-policy.mjs';

export function createHostAdapter({ connector, runtime, operations = ['sendTask', 'checkInbox', 'getResult', 'requestApproval', 'resolveContext'], packagePermissions = [], connectorGrants = [] }) {
  if (!connector || typeof connector !== 'object') throw new Error('connector is required');
  const adapter = { runtime };
  for (const operation of operations) {
    if (typeof connector[operation] !== 'function') throw new Error(`connector.${operation} is required`);
    assertCapability(operation, { packagePermissions, connectorGrants });
    adapter[operation] = async (...args) => connector[operation](...args);
  }
  return Object.freeze(adapter);
}
