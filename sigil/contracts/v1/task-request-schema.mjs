// Pure body-shape validation for message_type: 'task.request', per design §5.
// No repository access here -- consistent with the repo's no-heavy-dependency
// style and with validateEnvelope's synchronous/stateless contract.
function fail(field, reason) {
  throw Object.assign(new Error(`Invalid task.request body: ${reason}`), { code: 'INVALID_ENVELOPE', details: { field, reason } });
}

export function validateTaskRequestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body', 'must be an object');
  if (typeof body.task_id !== 'string' || !body.task_id) fail('task_id', 'required non-empty string');
  if (typeof body.instruction !== 'string' || !body.instruction) fail('instruction', 'required non-empty string');
  if ('success_criteria' in body && !Array.isArray(body.success_criteria)) fail('success_criteria', 'must be an array');
  if ('dependencies' in body && !Array.isArray(body.dependencies)) fail('dependencies', 'must be an array');
  if ('deadline' in body && (typeof body.deadline !== 'string' || !Number.isFinite(Date.parse(body.deadline)))) fail('deadline', 'must be an ISO 8601 date string');
}
