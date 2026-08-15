const CONTRACT = /^sigil\.connector\/v(\d+)$/;

export function validateConnectorRequest({ headers = {}, body = {} } = {}) {
  const requestId = headers['x-sigil-request-id'];
  const contract = headers['x-sigil-contract'];
  const caller = headers['x-sigil-caller'];
  const scope = body?.capability_scope ?? headers['x-sigil-capability-scope'];
  if (!requestId || !/^[A-Za-z0-9._~-]{8,200}$/.test(requestId)) throw Object.assign(new Error('request ID is required'), { code: 'INVALID_REQUEST_ID' });
  const version = CONTRACT.exec(contract ?? '');
  if (!version || version[1] !== '1') throw Object.assign(new Error('unsupported connector contract'), { code: 'VERSION_UNSUPPORTED' });
  if (!caller || !/^[A-Za-z0-9._:-]{3,200}$/.test(caller)) throw Object.assign(new Error('caller identity is required'), { code: 'INVALID_CALLER' });
  if (!scope || typeof scope !== 'string' || !scope.includes('/')) throw Object.assign(new Error('capability scope is required'), { code: 'CAPABILITY_SCOPE_REQUIRED' });
  return Object.freeze({ requestId, contract, caller, scope });
}
