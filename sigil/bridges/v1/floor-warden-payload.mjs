// sigil/bridges/v1/floor-warden-payload.mjs
// Pure builders for the Floor Warden webhook frames (spec: "Bridge payload").
// No I/O, no clocks: callers pass `now` (a Date).
//
// buildForwardPayload({ room, bot, invocation, trigger, thread, watermark, replyUrl, agentTurnsLeft, now })
//   room        { id, name }
//   bot         { bot_id, endpoint_id, display_name }
//   invocation  { id, decided_by }
//   trigger     { message_id, room_seq, thread_root_id, sender: { endpoint_id, kind, display_name }, text, created_at }
//   thread      candidate messages of the trigger's thread, any order: [{ room_seq, message_id, sender_endpoint_id, text }]
//   watermark   last room_seq already forwarded for this thread, or null/undefined (first forward: catch_up.reset)
//   replyUrl    full reply route URL for this room
//   agentTurnsLeft number
//   Returns the room.message frame. Thread keeps seq > watermark, trigger excluded, last 20, text clipped
//   to 4000 chars, oldest first. Over PAYLOAD_MAX_BYTES the oldest thread entries drop and
//   catch_up.truncated is true. trigger.text is never clipped.
//
// buildHaltPayload({ bot, invocation, trigger, halt, now })
//   invocation { id }, trigger { message_id }, halt { room_seq, message_id, reason }
//   Returns the halt frame (delivery_key `halt:<invocation id>`, no thread).
//
// Neither frame carries tokens, keys or the subject human id.

export const PAYLOAD_SCHEMA = 'sigil.floor_warden/1';
export const PAYLOAD_MAX_BYTES = 256 * 1024;
export const THREAD_LIMIT = 20;
export const THREAD_TEXT_MAX = 4000;
export const REPLY_TEXT_MAX = 16000;

function clip(text) {
  let out = String(text ?? '').slice(0, THREAD_TEXT_MAX);
  const last = out.charCodeAt(out.length - 1);
  if (out.length === THREAD_TEXT_MAX && last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

const size = (value) => Buffer.byteLength(JSON.stringify(value));

export function buildForwardPayload({ room, bot, invocation, trigger, thread = [], watermark = null, replyUrl, agentTurnsLeft, now }) {
  const hasMark = Number.isInteger(watermark);
  const kept = thread
    .filter((m) => m.message_id !== trigger.message_id && m.room_seq < trigger.room_seq && (!hasMark || m.room_seq > watermark))
    .sort((a, b) => a.room_seq - b.room_seq)
    .slice(-THREAD_LIMIT)
    .map((m) => ({ room_seq: m.room_seq, message_id: m.message_id, sender_endpoint_id: m.sender_endpoint_id, text: clip(m.text) }));
  const payload = {
    schema: PAYLOAD_SCHEMA,
    type: 'room.message',
    delivery_key: invocation.id,
    room: { id: room.id, name: room.name },
    target_bot: { bot_id: bot.bot_id, endpoint_id: bot.endpoint_id, display_name: bot.display_name },
    invocation: { id: invocation.id, decided_by: invocation.decided_by },
    trigger: {
      message_id: trigger.message_id,
      room_seq: trigger.room_seq,
      thread_root_id: trigger.thread_root_id,
      sender: { endpoint_id: trigger.sender.endpoint_id, kind: trigger.sender.kind, display_name: trigger.sender.display_name },
      text: trigger.text,
      created_at: trigger.created_at,
    },
    thread: kept,
    catch_up: { from_seq: hasMark ? watermark : null, to_seq: trigger.room_seq, truncated: false, reset: !hasMark },
    reply: { url: replyUrl, in_reply_to: trigger.message_id, idempotency_key: `${trigger.message_id}:${bot.bot_id}`, text_max: REPLY_TEXT_MAX },
    limits: { agent_turns_left: agentTurnsLeft },
    untrusted_fields: ['trigger.text', 'thread[].text'],
    sent_at: now.toISOString(),
  };
  while (payload.thread.length > 0 && size(payload) > PAYLOAD_MAX_BYTES) {
    payload.thread.shift();
    payload.catch_up.truncated = true;
  }
  return payload;
}

export function buildHaltPayload({ bot, invocation, trigger, halt, now }) {
  return {
    schema: PAYLOAD_SCHEMA,
    type: 'halt',
    delivery_key: `halt:${invocation.id}`,
    target_bot: { bot_id: bot.bot_id, endpoint_id: bot.endpoint_id, display_name: bot.display_name },
    invocation: { id: invocation.id },
    trigger: { message_id: trigger.message_id },
    halt: { room_seq: halt.room_seq, message_id: halt.message_id, reason: halt.reason },
    sent_at: now.toISOString(),
  };
}
