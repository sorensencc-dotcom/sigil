export function registerEndpoint(input, { humans = new Map(), endpoints = new Map() } = {}) {
  if (!input?.endpoint_id || !input.owner_id || !input.installation_id || !input.runtime || !input.key_id || !input.public_key) {
    return { status: 400, body: { code: 'INVALID_ENVELOPE', message: 'endpoint_id, owner_id, installation_id, runtime, key_id, and public_key are required' } };
  }
  const human = humans.get(input.owner_id);
  if (!human) return { status: 404, body: { code: 'UNKNOWN_ENDPOINT', message: 'Owner is not registered' } };
  if (human.status !== 'active') return { status: 403, body: { code: 'ROUTE_NOT_AUTHORIZED', message: 'Owner is not active' } };
  if (input.algorithm && input.algorithm !== 'Ed25519') return { status: 400, body: { code: 'INVALID_ENVELOPE', message: 'Only Ed25519 endpoint keys are supported' } };
  if (!input.public_key?.type || input.public_key.type !== 'public') return { status: 400, body: { code: 'INVALID_ENVELOPE', message: 'A public key object is required' } };
  if (endpoints.has(input.endpoint_id)) return { status: 409, body: { code: 'DUPLICATE_MESSAGE', message: 'Endpoint already exists' } };
  const endpoint = {
    endpoint_id: input.endpoint_id,
    owner_id: input.owner_id,
    installation_id: input.installation_id,
    runtime: input.runtime,
    display_name: input.display_name ?? input.endpoint_id,
    status: 'active',
    key_id: input.key_id,
    public_key: input.public_key
  };
  endpoints.set(endpoint.endpoint_id, endpoint);
  return { status: 201, body: { code: 'REGISTERED', endpoint_id: endpoint.endpoint_id }, endpoint };
}
