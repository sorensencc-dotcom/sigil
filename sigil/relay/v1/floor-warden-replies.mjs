// Floor Warden reply route handler: POST /v1/rooms/{room_id}/replies.
// The gate in http-server.mjs has already matched the reply token (spec
// "Reply route" steps 1-2). This file runs steps 3-6 and 8-10 in spec order:
// body shape, roster, room and membership, in_reply_to, running invocation,
// sign and accept. Step 7 (idempotency) slots in before the invocation check.
// No error body, log line or thrown message here carries the reply token,
// the reply text, or key material.
import crypto from 'node:crypto';
import { LocalOutbox } from '../../connectors/v1/local-outbox.mjs';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { validateRoomMessageBody } from '../../contracts/v1/room-message-schema.mjs';
import { threadRootOf } from './room-dispatch.mjs';

export const REPLY_BODY_MAX_BYTES = 96 * 1024;
export const REPLY_TEXT_MAX = 16000;
export const REPLY_IDEMPOTENCY_KEY_MAX = 128;
const FIELDS = ['room_id', 'target_bot_id', 'sender', 'in_reply_to', 'text', 'idempotency_key'];
const FIELD_SET = new Set(FIELDS);
const SIGNING_UNAVAILABLE = new Set(['NO_SIGNING_KEY', 'KEY_MISMATCH', 'WRAP_KEY_UNAVAILABLE']);

const fail = (status, code, message) => ({ status, body: { code, message, details: {} } });

// Step 3. Returns { reply } or { error }. The text is trimmed before the
// length check, and the trimmed text is what gets signed.
function parseReplyBody(raw, roomId) {
  let body;
  try { body = JSON.parse(raw); } catch { return { error: fail(400, 'INVALID_REQUEST', 'Body must be JSON') }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: fail(400, 'INVALID_REQUEST', 'Body must be an object') };
  for (const field of Object.keys(body)) if (!FIELD_SET.has(field)) return { error: fail(400, 'INVALID_REQUEST', `Unknown field: ${field}`) };
  for (const field of FIELDS) {
    if (typeof body[field] !== 'string' || !body[field]) return { error: fail(400, 'INVALID_REQUEST', `${field} is required`) };
  }
  if (body.room_id !== roomId) return { error: fail(400, 'INVALID_REQUEST', 'room_id must match the path') };
  if (body.idempotency_key.length > REPLY_IDEMPOTENCY_KEY_MAX) return { error: fail(400, 'INVALID_REQUEST', `idempotency_key must be 1-${REPLY_IDEMPOTENCY_KEY_MAX} characters`) };
  const text = body.text.trim();
  if (!text || text.length > REPLY_TEXT_MAX) return { error: fail(400, 'INVALID_REQUEST', `text must be 1-${REPLY_TEXT_MAX} characters after trimming`) };
  return { reply: { targetBotId: body.target_bot_id, sender: body.sender, inReplyTo: body.in_reply_to, text, idempotencyKey: body.idempotency_key } };
}

export async function handleFloorWardenReply({ request, requestId, roomId, now, readBody, repository, botSigner, buildAcceptOptions }) {
  let raw;
  try { raw = await readBody(request, REPLY_BODY_MAX_BYTES); } catch { return fail(400, 'INVALID_REQUEST', `Body must be at most ${REPLY_BODY_MAX_BYTES} bytes`); }
  const parsed = parseReplyBody(raw, roomId);
  if (parsed.error) return parsed.error;
  const { reply } = parsed;

  // Step 4: the roster is the allowlist. Nothing about the room is read
  // before this passes, so a caller cannot probe rooms or members.
  const bot = await repository.lookupFloorWardenBot(reply.targetBotId);
  if (!bot || bot.status !== 'active' || bot.endpoint_id !== reply.sender) return fail(403, 'BOT_NOT_ON_ROSTER', 'target_bot_id is not an active rostered bot for this sender');

  // Step 5.
  const room = await repository.lookupRoom(roomId);
  if (!room) return fail(404, 'ROOM_NOT_FOUND', 'Room not found');
  if (!(await repository.lookupRoomMember(roomId, bot.endpoint_id))) return fail(403, 'BOT_NOT_A_MEMBER', 'The bot endpoint is not a member of this room');

  // Step 6.
  const trigger = await repository.lookupRoomMessage(roomId, reply.inReplyTo);
  if (!trigger) return fail(404, 'MESSAGE_NOT_FOUND', 'in_reply_to is not a message in this room');
  const threadRootId = threadRootOf(trigger.envelope ?? { message_id: trigger.message_id });

  // Step 7 (idempotency replay) belongs here, before the invocation check.

  // Step 8: the reply must answer the running invocation's own trigger, not
  // merely a message in the same thread.
  const running = await repository.lookupRunningInvocation(roomId, bot.endpoint_id);
  if (!running || running.trigger_message_id !== reply.inReplyTo) return fail(403, 'ROOM_NOT_INVOKED', 'The bot has no running invocation for in_reply_to');

  // Step 9.
  if (!botSigner || !buildAcceptOptions) return fail(503, 'BOT_SIGNING_UNAVAILABLE', 'Relay signing is unavailable for this bot');
  let signer;
  try {
    signer = await botSigner.signForBot(bot.endpoint_id);
  } catch (error) {
    if (error.code === 'ENDPOINT_REVOKED') return fail(403, 'ENDPOINT_REVOKED', 'The bot endpoint is not active');
    if (SIGNING_UNAVAILABLE.has(error.code)) return fail(503, 'BOT_SIGNING_UNAVAILABLE', 'Relay signing is unavailable for this bot');
    throw error;
  }
  const messageBody = { text: reply.text, thread_root_id: threadRootId, mentions: [] };
  validateRoomMessageBody(messageBody);
  const created = now instanceof Date ? now : new Date(now);
  const outbox = new LocalOutbox({ privateKey: signer.privateKey, endpoint: signer.endpoint });
  const { envelope } = outbox.queue({
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: roomId, message_type: 'room.message',
    sender: { owner_id: signer.endpoint.owner_id, endpoint_id: signer.endpoint.endpoint_id, kind: 'agent' },
    broadcast_scope: { conversation_id: roomId }, body: messageBody, context_refs: [], capabilities: [], correlation_id: reply.inReplyTo,
    idempotency_key: `room:${roomId}:fw_reply:${reply.idempotencyKey}`, created_at: created.toISOString(), expires_at: new Date(created.getTime() + 24 * 3600_000).toISOString(),
    signature: { algorithm: 'Ed25519', key_id: signer.endpoint.key_id, value: '' },
  });
  const result = await acceptEnvelopeAsync(envelope, buildAcceptOptions({ request_id: requestId, now }));
  // The relay signed with a key its own registry rejects: a relay fault.
  if (result.status === 401 && (result.body?.code === 'UNKNOWN_ENDPOINT' || result.body?.code === 'INVALID_SIGNATURE')) return fail(500, 'INTERNAL', 'Relay failed to sign the reply');
  if (result.status !== 202) {
    const { request_id: _ignored, ...rest } = result.body ?? {};
    return { status: result.status, body: rest };
  }

  // Step 10.
  const row = await repository.lookupRoomMessage(roomId, result.body.message_id);
  return { status: 202, body: { message_id: result.body.message_id, room_seq: row?.room_seq ?? null, duplicate: Boolean(result.body.duplicate) } };
}

// Binds the relay's dependencies so the http-server gate can call
// handler({ request, response, requestId, roomId, now, readBody }).
export function createFloorWardenReplyHandler({ repository, botSigner, buildAcceptOptions }) {
  return (ctx) => handleFloorWardenReply({ ...ctx, repository, botSigner, buildAcceptOptions });
}
