function assertResponse(response, body) {
  if (!response.ok || body.code !== 'OK') {
    throw Object.assign(new Error(body.message ?? 'Connector request failed'), { code: body.code ?? 'CONNECTOR_UNAVAILABLE', status: response.status });
  }
  return body.result;
}

export function createLocalConnectorClient({ baseUrl, token, fetchImpl = fetch } = {}) {
  if (!baseUrl || !token || typeof fetchImpl !== 'function') throw new Error('baseUrl, token, and fetchImpl are required');
  const request = async (method, path, input) => {
    const response = await fetchImpl(new URL(path, baseUrl), {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(input ?? {}) })
    });
    return assertResponse(response, await response.json());
  };
  return Object.freeze({
    sendTask: (input) => request('POST', '/v1/tasks', input),
    checkInbox: (since = '') => request('GET', `/v1/inbox?since=${encodeURIComponent(since)}`),
    getResult: (taskId) => request('GET', `/v1/results?task_id=${encodeURIComponent(taskId)}`),
    requestApproval: (input) => request('POST', '/v1/approvals', input),
    resolveContext: (input) => request('POST', '/v1/context', input),
    processDelivery: (input) => request('POST', '/v1/process', input),
    submitResult: (input) => request('POST', '/v1/results', input)
  });
}
