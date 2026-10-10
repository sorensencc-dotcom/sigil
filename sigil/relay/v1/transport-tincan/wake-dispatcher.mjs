export const BRIDGES = new Set(['claude', 'codex', 'router']);

export function createWakeDispatcher({ spawnFn, checkRunningFn }) {
  return {
    async wakeAgent({ endpointId, bridgeType, identityPath, relayUrl, sessionStore = '.sigil/room-sessions.json' }) {
      if (!BRIDGES.has(bridgeType)) throw Object.assign(new Error(`Unsupported room bridge: ${bridgeType}`), { code: 'INVALID_REQUEST' });
      if (await checkRunningFn(endpointId)) return { alreadyRunning: true, endpointId };
      const args = ['sigil/cli/sigil.mjs', 'agent', 'run', '--identity', identityPath, '--relay-url', relayUrl, '--room-bridge', bridgeType, '--room-sessions', sessionStore];
      const child = await spawnFn('node', args);
      return { alreadyRunning: false, endpointId, pid: child.pid };
    },
  };
}
