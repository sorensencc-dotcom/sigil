// Body shape for message_type: 'room.event' (rooms design, phase 3). Only the
// relay emits these; clients cannot post them (room-policy.mjs refuses the type).
export const ROOM_EVENT_KINDS = new Set(['router_decision', 'invocation_refused', 'invocation_stopped', 'router_failed']);
export const ROOM_EVENT_REASON_MAX = 280;
export const ROOM_EVENT_ENDPOINTS_MAX = 50;
const ALLOWED_FIELDS = new Set(['kind', 'invocation_id', 'endpoint_ids', 'reason']);

function fail(field, reason) {
  throw Object.assign(new Error(`Invalid room.event body: ${reason}`), { code: 'INVALID_ENVELOPE', details: { field, reason } });
}

export function validateRoomEventBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body', 'must be an object');
  for (const field of Object.keys(body)) if (!ALLOWED_FIELDS.has(field)) fail(field, 'unknown field');
  if (!ROOM_EVENT_KINDS.has(body.kind)) fail('kind', 'unknown event kind');
  if (!Array.isArray(body.endpoint_ids) || body.endpoint_ids.length > ROOM_EVENT_ENDPOINTS_MAX || body.endpoint_ids.some((id) => typeof id !== 'string' || !id)) {
    fail('endpoint_ids', 'must be an array of non-empty strings');
  }
  if ('invocation_id' in body && (typeof body.invocation_id !== 'string' || !body.invocation_id)) fail('invocation_id', 'must be a non-empty string');
  if ('reason' in body && (typeof body.reason !== 'string' || body.reason.length > ROOM_EVENT_REASON_MAX)) fail('reason', `must be a string of at most ${ROOM_EVENT_REASON_MAX} characters`);
}

// Router reasons come from an LLM and are untrusted: strip control characters
// and cap the length before they reach a room.
export function clampReason(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, ROOM_EVENT_REASON_MAX);
}
