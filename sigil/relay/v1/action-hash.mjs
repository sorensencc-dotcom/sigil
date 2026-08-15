import crypto from 'node:crypto';

const ACTION_HASH_ALGORITHM = 'sha256:jcs-sigil-action-v1';
const ACTION_FIELDS = ['action_type', 'target', 'context_refs', 'requested_capabilities', 'arguments', 'endpoint_id', 'contract_version', 'policy_version'];

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  throw Object.assign(new Error('Action contains unsupported value'), { code: 'INVALID_ACTION' });
}

export function canonicalAction(action = {}) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw Object.assign(new Error('Action must be an object'), { code: 'INVALID_ACTION' });
  const selected = Object.fromEntries(ACTION_FIELDS.filter((field) => Object.hasOwn(action, field)).map((field) => [field, action[field]]));
  if (!selected.action_type || !selected.endpoint_id || !selected.contract_version) throw Object.assign(new Error('Action binding fields are required'), { code: 'INVALID_ACTION' });
  return canonicalize(selected);
}

export function computeActionHash(action) {
  return `${ACTION_HASH_ALGORITHM}:${crypto.createHash('sha256').update(canonicalAction(action)).digest('hex')}`;
}

export { ACTION_HASH_ALGORITHM, ACTION_FIELDS };
