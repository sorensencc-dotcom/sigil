function fail(field, reason) {
  throw Object.assign(new Error(`Invalid session.resend_request body: ${reason}`), {
    code: 'INVALID_ENVELOPE',
    details: { field, reason },
  });
}

export function validateSessionResendRequestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body', 'must be an object');
  if (typeof body.target_sender_endpoint_id !== 'string' || !body.target_sender_endpoint_id) {
    fail('target_sender_endpoint_id', 'required non-empty string');
  }
  if (typeof body.conversation_id !== 'string' || !body.conversation_id) fail('conversation_id', 'required non-empty string');
  if (!Number.isSafeInteger(body.begin_seq) || body.begin_seq < 1) fail('begin_seq', 'must be a positive safe integer');
  if (!Number.isSafeInteger(body.end_seq) || body.end_seq < 0) fail('end_seq', 'must be a non-negative safe integer');
}
