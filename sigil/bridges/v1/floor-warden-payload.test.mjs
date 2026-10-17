// sigil/bridges/v1/floor-warden-payload.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildForwardPayload, buildHaltPayload, PAYLOAD_MAX_BYTES } from './floor-warden-payload.mjs';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const bot = { bot_id: '016f0b34-f0da-49b2-a32f-482d6e635825', endpoint_id: 'ep_chief', display_name: 'Chief' };
const trigger = {
  message_id: 'msg_t', room_seq: 41, thread_root_id: 'msg_root',
  sender: { endpoint_id: 'ep_chris', kind: 'human', display_name: 'Chris' },
  text: 'hello <b>there</b>\u0007\u001b', created_at: '2026-10-16T11:59:00.000Z',
};
const msg = (seq, text = `m${seq}`) => ({ room_seq: seq, message_id: `msg_${seq}`, sender_endpoint_id: 'ep_x', text });
const base = (extra = {}) => ({
  room: { id: 'room_1', name: 'Ops' }, bot, invocation: { id: 'inv_1', decided_by: 'mention' }, trigger,
  thread: [], watermark: null, replyUrl: 'https://relay.example/v1/rooms/room_1/replies', agentTurnsLeft: 5, now: NOW, ...extra,
});
const keysOf = (value, out = []) => {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); keysOf(v, out); }
  return out;
};

test('forward payload matches the spec shape', () => {
  const p = buildForwardPayload(base({ thread: [msg(40)], watermark: 35 }));
  assert.deepEqual(p, {
    schema: 'sigil.floor_warden/1',
    type: 'room.message',
    delivery_key: 'inv_1',
    room: { id: 'room_1', name: 'Ops' },
    target_bot: bot,
    invocation: { id: 'inv_1', decided_by: 'mention' },
    trigger,
    thread: [msg(40)],
    catch_up: { from_seq: 35, to_seq: 41, truncated: false, reset: false },
    reply: { url: 'https://relay.example/v1/rooms/room_1/replies', in_reply_to: 'msg_t', idempotency_key: `msg_t:${bot.bot_id}`, text_max: 16000 },
    limits: { agent_turns_left: 5 },
    untrusted_fields: ['trigger.text', 'thread[].text'],
    sent_at: '2026-10-16T12:00:00.000Z',
  });
});

test('thread keeps seq above the watermark, max 20, oldest first, trigger excluded', () => {
  const thread = [];
  for (let seq = 1; seq <= 40; seq += 1) thread.push(msg(seq));
  for (let seq = 42; seq <= 45; seq += 1) thread.push(msg(seq)); // after the trigger: not catch-up
  thread.push({ ...msg(41), message_id: 'msg_t' });
  const p = buildForwardPayload(base({ thread: thread.reverse(), watermark: 10 }));
  assert.equal(p.thread.length, 20);
  assert.deepEqual(p.thread.map((m) => m.room_seq), [...Array(40).keys()].map((i) => i + 1).slice(-20));
  assert.ok(!p.thread.some((m) => m.message_id === 'msg_t'));
  assert.ok(p.thread.every((m, i, a) => i === 0 || a[i - 1].room_seq < m.room_seq));
});

test('thread messages clip to 4000 characters; trigger text is not clipped', () => {
  const long = 'a'.repeat(5000);
  const p = buildForwardPayload(base({ thread: [msg(40, long)], trigger: { ...trigger, text: long } }));
  assert.equal(p.thread[0].text.length, 4000);
  assert.equal(p.trigger.text.length, 5000);
});

test('no watermark resets catch-up; a watermark sets from_seq', () => {
  assert.deepEqual(buildForwardPayload(base()).catch_up, { from_seq: null, to_seq: 41, truncated: false, reset: true });
  assert.deepEqual(buildForwardPayload(base({ watermark: 35 })).catch_up, { from_seq: 35, to_seq: 41, truncated: false, reset: false });
});

test('over 256 KiB drops oldest thread entries and sets truncated, never clipping trigger text', () => {
  const chunk = 'b'.repeat(4000);
  const thread = [];
  for (let seq = 1; seq <= 20; seq += 1) thread.push(msg(seq, chunk));
  const bigTrigger = { ...trigger, text: 'c'.repeat(200 * 1024) };
  const p = buildForwardPayload(base({ thread, trigger: bigTrigger }));
  assert.equal(p.catch_up.truncated, true);
  assert.ok(p.thread.length < 20);
  assert.equal(p.thread.at(-1).room_seq, 20);
  assert.equal(p.trigger.text.length, 200 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(p)) <= PAYLOAD_MAX_BYTES);
  assert.equal(buildForwardPayload(base({ thread })).catch_up.truncated, false);
});

test('untrusted_fields lists trigger.text and thread[].text', () => {
  assert.deepEqual(buildForwardPayload(base()).untrusted_fields, ['trigger.text', 'thread[].text']);
});

test('payload carries no secret-named keys', () => {
  const banned = new Set(['subject_human_id', 'token', 'relay_token', 'key']);
  const keys = keysOf(buildForwardPayload(base({ thread: [msg(40)] }))).concat(keysOf(buildHaltPayload(haltInput())));
  assert.deepEqual(keys.filter((k) => banned.has(k)), []);
});

test('markup and control characters pass through unchanged as JSON strings', () => {
  const p = buildForwardPayload(base({ thread: [msg(40, '<script>\u0000\u0007</script>')] }));
  assert.equal(p.trigger.text, trigger.text);
  assert.equal(JSON.parse(JSON.stringify(p)).thread[0].text, '<script>\u0000\u0007</script>');
});

function haltInput() {
  return { bot, invocation: { id: 'inv_1' }, trigger: { message_id: 'msg_t' }, halt: { room_seq: 50, message_id: 'msg_h', reason: 'stopped' }, now: NOW };
}

test('halt payload has the halt frame and no thread', () => {
  const p = buildHaltPayload(haltInput());
  assert.deepEqual(p, {
    schema: 'sigil.floor_warden/1',
    type: 'halt',
    delivery_key: 'halt:inv_1',
    target_bot: bot,
    invocation: { id: 'inv_1' },
    trigger: { message_id: 'msg_t' },
    halt: { room_seq: 50, message_id: 'msg_h', reason: 'stopped' },
    sent_at: '2026-10-16T12:00:00.000Z',
  });
  assert.ok(!('thread' in p));
});
