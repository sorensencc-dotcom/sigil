import crypto from 'node:crypto';

function assertResponse(response, body) {
  if (!response.ok || body.code !== 'OK') {
    throw Object.assign(new Error(body.message ?? 'Connector request failed'), { code: body.code ?? 'CONNECTOR_UNAVAILABLE', status: response.status });
  }
  return body.result;
}

export function createLocalConnectorClient({ baseUrl, token, fetchImpl = fetch } = {}) {
  if (!baseUrl || !token || typeof fetchImpl !== 'function') throw new Error('baseUrl, token, and fetchImpl are required');
  const request = async (method, path, input, { idempotencyKey, caller = 'sigil.local-host', packageId, capabilityScope } = {}) => {
    const requiredScope = capabilityScope ?? (method === 'GET' && path.startsWith('/v1/results') ? 'sigil.task/read_result' : (Object.entries({ '/v1/tasks': 'sigil.task/submit', '/v1/inbox': 'sigil.task/read_inbox', '/v1/approvals': 'sigil.approval/request', '/v1/context': 'sigil.core/read_shared_context', '/v1/process': 'sigil.task/process', '/v1/results': 'sigil.task/submit_result' }).find(([prefix]) => path.startsWith(prefix))?.[1] ?? 'sigil.connector/request'));
    const response = await fetchImpl(new URL(path, baseUrl), {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-sigil-request-id': crypto.randomUUID(), 'x-sigil-contract': 'sigil.connector/v1', 'x-sigil-caller': caller, 'x-sigil-capability-scope': requiredScope, ...(packageId ? { 'x-sigil-package-id': packageId } : {}), ...(idempotencyKey ? { 'x-sigil-idempotency-key': idempotencyKey } : {}) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(input ?? {}) })
    });
    return assertResponse(response, await response.json());
  };
  return Object.freeze({
    sendTask: (input, options) => request('POST', '/v1/tasks', input, options),
    checkInbox: (since = '') => request('GET', `/v1/inbox?since=${encodeURIComponent(since)}`),
    getResult: (taskId) => request('GET', `/v1/results?task_id=${encodeURIComponent(taskId)}`),
    requestApproval: (input, options) => request('POST', '/v1/approvals', input, options),
    resolveContext: (input) => request('POST', '/v1/context', input),
    processDelivery: (input, options) => request('POST', '/v1/process', input, options),
    submitResult: (input, options) => request('POST', '/v1/results', input, options)
  });
}
