// Pure body-shape validation for message_type: 'task.result', per design §5.
const VALID_STATUSES = new Set(['accepted', 'in_progress', 'completed', 'blocked', 'rejected', 'expired']);

function fail(field, reason) {
  throw Object.assign(new Error(`Invalid task.result body: ${reason}`), { code: 'INVALID_ENVELOPE', details: { field, reason } });
}

export function validateTaskResultBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body', 'must be an object');
  if (typeof body.task_id !== 'string' || !body.task_id) fail('task_id', 'required non-empty string');
  if (typeof body.status !== 'string' || !VALID_STATUSES.has(body.status)) fail('status', `must be one of ${[...VALID_STATUSES].join(' | ')}`);
  if (typeof body.summary !== 'string' || !body.summary) fail('summary', 'required non-empty string');
  if ('findings' in body && !Array.isArray(body.findings)) fail('findings', 'must be an array');
  if ('artifacts' in body && !Array.isArray(body.artifacts)) fail('artifacts', 'must be an array');
  if ('verification' in body && !Array.isArray(body.verification)) fail('verification', 'must be an array');
}
