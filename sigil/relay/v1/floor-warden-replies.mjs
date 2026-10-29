// Floor Warden reply route handler: POST /v1/rooms/{room_id}/replies.
// The gate in http-server.mjs has already matched the reply token (spec
// "Reply route" steps 1-2). This file runs steps 3-10 in spec order: body
// shape, roster, room and membership, in_reply_to, idempotency replay,
// running invocation, sign and accept, answer. Every answered call writes one
// room.floor_warden_reply audit row.
// No error body, audit row, log line or thrown message here carries the reply
// token, the reply text, or key material.
import crypto from 'node:crypto';
import { logHop } from './hop-log.mjs';
import { LocalOutbox } from '../../connectors/v1/local-outbox.mjs';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { validateRoomMessageBody } from '../../contracts/v1/room-message-schema.mjs';
import { threadRootOf } from './room-dispatch.mjs';

export const REPLY_BODY_MAX_BYTES = 96 * 1024;
export const REPLY_TEXT_MAX = 16000;
export const REPLY_IDEMPOTENCY_KEY_MAX = 128;
const FIELDS = ['room_id', 'target_bot_id', 'sender', 'in_reply_to', 'text', 'idempotency_key'];
const FIELD_SET = new Set(FIELDS);
const SIGNING_UNAVAILABLE = new Set(['NO_SIGNING_KEY', 'KEY_MISMATCH', 'WRAP_KEY_UNAVAILABLE', 'KEY_UNWRAP_FAILED', 'WRAPPED_KEY_INVALID']);
const ECHO_MAX = 64;
const AUDIT_ID_MAX = 128;

const fail = (status, code, message) => ({ status, body: { code, message, details: {} } });
const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

// Step 3. Returns { reply } or { error }. The text is trimmed before the
// length check, and the trimmed text is what gets signed.
function parseReplyBody(raw, roomId) {
  let body;
  try { body = JSON.parse(raw); } catch { return { error: fail(400, 'INVALID_REQUEST', 'Body must be JSON') }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: fail(400, 'INVALID_REQUEST', 'Body must be an object') };
  for (const field of Object.keys(body)) if (!FIELD_SET.has(field)) return { error: fail(400, 'INVALID_REQUEST', `Unknown field: ${field.slice(0, ECHO_MAX)}`) };
  for (const field of FIELDS) {
    if (typeof body[field] !== 'string' || !body[field]) return { error: fail(400, 'INVALID_REQUEST', `${field} is required`) };
  }
  if (body.room_id !== roomId) return { error: fail(400, 'INVALID_REQUEST', 'room_id must match the path') };
  if (body.idempotency_key.length > REPLY_IDEMPOTENCY_KEY_MAX) return { error: fail(400, 'INVALID_REQUEST', `idempotency_key must be 1-${REPLY_IDEMPOTENCY_KEY_MAX} characters`) };
  const text = body.text.trim();
  if (!text || text.length > REPLY_TEXT_MAX) return { error: fail(400, 'INVALID_REQUEST', `text must be 1-${REPLY_TEXT_MAX} characters after trimming`) };
  return { reply: { targetBotId: body.target_bot_id, sender: body.sender, inReplyTo: body.in_reply_to, text, idempotencyKey: body.idempotency_key } };
}

// `facts` collects what the audit row may name as each check passes: the
// claimed bot and sender after parsing, the room only once it is known to
// exist, and the message id once one is accepted or replayed.
async function runReply({ request, requestId, roomId, now, readBody, repository, botSigner, buildAcceptOptions, botId }, facts) {
  let raw;
  try { raw = await readBody(request, REPLY_BODY_MAX_BYTES); } catch { return fail(400, 'INVALID_REQUEST', `Body must be at most ${REPLY_BODY_MAX_BYTES} bytes`); }
  const parsed = parseReplyBody(raw, roomId);
  if (parsed.error) return parsed.error;
  const { reply } = parsed;
  logHop('relay.reply_received', { room_id: roomId, in_reply_to: reply.inReplyTo, bot_id: reply.targetBotId });
  if (botId && botId !== reply.targetBotId) return { ...fail(403, 'BOT_NOT_ON_ROSTER', 'target_bot_id does not match the reply token bot'), noAudit: true };
  // Caller-claimed and unverified until step 4 passes: on refusal rows these
  // name what the caller asserted, not a checked identity.
  facts.botId = clip(reply.targetBotId, AUDIT_ID_MAX);
  facts.endpointId = clip(reply.sender, AUDIT_ID_MAX);

  // Step 4: the roster is the allowlist. Nothing about the room is read
  // before this passes, so a caller cannot probe rooms or members.
  const bot = await repository.lookupFloorWardenBot(reply.targetBotId);
  if (!bot || bot.status !== 'active' || bot.endpoint_id !== reply.sender) return fail(403, 'BOT_NOT_ON_ROSTER', 'target_bot_id is not an active rostered bot for this sender');

  // Step 5.
  const room = await repository.lookupRoom(roomId);
  if (!room) return fail(404, 'ROOM_NOT_FOUND', 'Room not found');
  facts.roomId = roomId;
  if (!(await repository.lookupRoomMember(roomId, bot.endpoint_id))) return fail(403, 'BOT_NOT_A_MEMBER', 'The bot endpoint is not a member of this room');

  // Step 6.
  const trigger = await repository.lookupRoomMessage(roomId, reply.inReplyTo);
  if (!trigger) return fail(404, 'MESSAGE_NOT_FOUND', 'in_reply_to is not a message in this room');
  const threadRootId = threadRootOf(trigger.envelope ?? { message_id: trigger.message_id });

  // Step 7: a stored key replays the first result, whatever the text now
  // says. It runs before step 8 because the first reply completed the
  // invocation. The key is scoped to the room, so one key in two rooms never
  // collides.
  const scopedKey = `room:${roomId}:fw_reply:${reply.idempotencyKey}`;
  const stored = async () => {
    const prior = await repository.lookupIdempotency(bot.endpoint_id, scopedKey);
    if (!prior) return null;
    const row = await repository.lookupRoomMessage(roomId, prior.message_id);
    if (!row) return null;
    facts.messageId = prior.message_id;
    return { status: 202, body: { message_id: prior.message_id, room_seq: row.room_seq ?? null, duplicate: true } };
  };
  const replay = await stored();
  if (replay) return replay;

  // Step 8: the reply must answer the running invocation's own trigger, not
  // merely a message in the same thread. A racing duplicate under the same key
  // may have committed since step 7; re-read it before refusing.
  const running = await repository.lookupRunningInvocation(roomId, bot.endpoint_id);
  if (!running || running.trigger_message_id !== reply.inReplyTo) return (await stored()) ?? fail(403, 'ROOM_NOT_INVOKED', 'The bot has no running invocation for in_reply_to');

  // Step 9.
  if (!botSigner || !buildAcceptOptions) return fail(503, 'BOT_SIGNING_UNAVAILABLE', 'Relay signing is unavailable for this bot');
  let signer;
  try {
    signer = await botSigner.signForBot(bot.endpoint_id);
  } catch (error) {
    if (error?.code === 'ENDPOINT_REVOKED') return fail(403, 'ENDPOINT_REVOKED', 'The bot endpoint is not active');
    if (SIGNING_UNAVAILABLE.has(error?.code)) return fail(503, 'BOT_SIGNING_UNAVAILABLE', 'Relay signing is unavailable for this bot');
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
    idempotency_key: scopedKey, created_at: created.toISOString(), expires_at: new Date(created.getTime() + 24 * 3600_000).toISOString(),
    signature: { algorithm: 'Ed25519', key_id: signer.endpoint.key_id, value: '' },
  });
  // expectedTriggerMessageId makes accept refuse, under its transaction, a
  // running invocation for any other trigger (single-shot completion).
  const result = await acceptEnvelopeAsync(envelope, { ...buildAcceptOptions({ request_id: requestId, now }), expectedTriggerMessageId: reply.inReplyTo });
  // A freshly signed envelope never matches a stored canonical hash, so a
  // racing duplicate that loses surfaces as 409 DUPLICATE_MESSAGE (the
  // idempotency insert lost) or 403 ROOM_NOT_INVOKED (the winner completed the
  // invocation first). Either way re-read the key and answer with the winner;
  // with nothing stored, the error is real and passes through.
  if ((result.status === 409 && result.body?.code === 'DUPLICATE_MESSAGE') || (result.status === 403 && result.body?.code === 'ROOM_NOT_INVOKED')) {
    const winner = await stored();
    if (winner) return winner;
  }
  // The relay signed with a key its own registry rejects: a relay fault.
  if (result.status === 401 && (result.body?.code === 'UNKNOWN_ENDPOINT' || result.body?.code === 'INVALID_SIGNATURE')) return fail(500, 'INTERNAL', 'Relay failed to sign the reply');
  if (result.status !== 202) {
    const { request_id: _ignored, ...rest } = result.body ?? {};
    return { status: result.status, body: rest };
  }

  // Step 10.
  facts.messageId = result.body.message_id;
  const row = await repository.lookupRoomMessage(roomId, result.body.message_id);
  logHop('relay.reply_persisted', { room_id: roomId, in_reply_to: reply.inReplyTo, message_id: result.body.message_id, room_seq: row?.room_seq ?? null, duplicate: Boolean(result.body.duplicate) });
  return { status: 202, body: { message_id: result.body.message_id, room_seq: row?.room_seq ?? null, duplicate: Boolean(result.body.duplicate) } };
}

export async function handleFloorWardenReply(ctx) {
  const facts = { botId: null, endpointId: null, roomId: null, messageId: null };
  const audit = (outcome, reason, status) => ctx.repository.recordAuditEvent({
    eventType: 'room.floor_warden_reply', subjectId: facts.botId ?? 'unknown', endpointId: facts.endpointId, conversationId: facts.roomId,
    objectType: 'room_message', objectId: facts.messageId, outcome, reason,
    payload: { request_id: ctx.requestId ?? null, status }, now: ctx.now,
  });
  let result;
  try {
    result = await runReply(ctx, facts);
  } catch (error) {
    // The http gate answers a throw with 503 DATABASE_UNAVAILABLE; the call
    // still gets its audit row. A failing audit write must not mask the throw.
    await audit('refused', 'DATABASE_UNAVAILABLE', 503).catch(() => {});
    throw error;
  }
  if (result.noAudit) return result;
  const accepted = result.status === 202;
  await audit(accepted ? (result.body.duplicate ? 'duplicate' : 'accepted') : 'refused', accepted ? null : result.body?.code ?? null, result.status);
  return result;
}

// Binds the relay's dependencies so the http-server gate can call
// handler({ request, response, requestId, roomId, now, readBody }).
export function createFloorWardenReplyHandler({ repository, botSigner, buildAcceptOptions }) {
  return (ctx) => handleFloorWardenReply({ ...ctx, repository, botSigner, buildAcceptOptions });
}
