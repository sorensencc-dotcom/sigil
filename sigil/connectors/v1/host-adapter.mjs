export function createHostAdapter({ connector, runtime, operations = ['sendTask', 'checkInbox', 'getResult', 'requestApproval', 'resolveContext'] }) {
  if (!connector || typeof connector !== 'object') throw new Error('connector is required');
  const adapter = { runtime };
  for (const operation of operations) {
    if (typeof connector[operation] !== 'function') throw new Error(`connector.${operation} is required`);
    adapter[operation] = async (...args) => connector[operation](...args);
  }
  return Object.freeze(adapter);
}
