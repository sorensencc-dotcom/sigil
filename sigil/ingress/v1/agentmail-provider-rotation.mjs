export class AgentMailProviderRotationPort {
  async rotate() { return { supported: false, committed: false, receipt: { outcome: 'unsupported' } }; }
}

export function createAgentMailProviderRotationPort({ rotate } = {}) {
  if (typeof rotate !== 'function') return new AgentMailProviderRotationPort();
  return Object.freeze({ rotate });
}
