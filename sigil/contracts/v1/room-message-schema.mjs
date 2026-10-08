// Pure body-shape validation for message_type: 'room.message' (rooms design, phase 1).
export const ROOM_MESSAGE_TEXT_MAX = 20000;
export const ROOM_MESSAGE_MENTIONS_MAX = 50;
const ALLOWED_FIELDS = new Set(['text', 'thread_root_id', 'mentions']);

function fail(field, reason) {
  throw Object.assign(new Error(`Invalid room.message body: ${reason}`), {
    code: 'INVALID_ENVELOPE',
    details: { field, reason },
  });
}

export function validateRoomMessageBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body', 'must be an object');
  for (const field of Object.keys(body)) if (!ALLOWED_FIELDS.has(field)) fail(field, 'unknown field');
  if (typeof body.text !== 'string' || !body.text) fail('text', 'required non-empty string');
  if (body.text.length > ROOM_MESSAGE_TEXT_MAX) fail('text', `must be at most ${ROOM_MESSAGE_TEXT_MAX} characters`);
  if ('thread_root_id' in body && (typeof body.thread_root_id !== 'string' || !body.thread_root_id)) fail('thread_root_id', 'must be a non-empty string');
  if ('mentions' in body) {
    if (!Array.isArray(body.mentions)) fail('mentions', 'must be an array');
    if (body.mentions.length > ROOM_MESSAGE_MENTIONS_MAX) fail('mentions', `must have at most ${ROOM_MESSAGE_MENTIONS_MAX} entries`);
    if (body.mentions.some((id) => typeof id !== 'string' || !id)) fail('mentions', 'entries must be non-empty strings');
  }
}
