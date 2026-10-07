// Every transport that calls acceptEnvelopeAsync must pass the same option set,
// or a room message accepted over p2p or AgentMail skips routing and
// room.updated. Build the base once in cmdRelayUp; each transport overrides only
// what differs per request (request_id, and for p2p the peer identity check).
export const ACCEPT_OPTION_KEYS = Object.freeze([
  'registered', 'request_id', 'now', 'repository', 'relayDomain', 'persist',
  'federationMode', 'federationIdentity', 'fetchImpl', 'stream_seq', 'resendMetrics',
  'logger', 'onPersisted', 'systemIdentity', 'stream',
]);

export function createAcceptOptionsBuilder(base) {
  for (const key of ACCEPT_OPTION_KEYS) {
    if (!(key in base)) throw new Error(`accept options base is missing "${key}"`);
  }
  return (overrides = {}) => ({ ...base, ...overrides });
}
