// sigil/bridges/v1/room-bridge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIdentity, identityKeys } from '../../cli/identity.mjs';
import { LocalOutbox } from '../../connectors/v1/local-outbox.mjs';
import { createSessionStore } from './session-store.mjs';
import { createRoomBridge, ROOM_PREAMBLE } from './room-bridge.mjs';

const identity = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_claude', kind: 'agent' });
const trigger = { message_id: 'msg_t', conversation_id: 'room_1', sender: { endpoint_id: 'ep_web' }, body: { text: 'hi @ep_claude', mentions: ['ep_claude'] } };
const invocation = { invocation_id: 'inv_1', trigger_message_id: 'msg_t', thread_root_id: 'msg_t', status: 'running' };

function fakeRelay({ running = [invocation], runningAfterFirstPoll } = {}) {
  const sent = [];
  const failed = [];
  let polls = 0;
  return {
    sent, failed,
    async listRoomInvocations() { polls += 1; return polls > 1 && runningAfterFirstPoll ? runningAfterFirstPoll : running; },
    async listRoomMembers() { return [{ endpoint_id: 'ep_web', response_mode: null }, { endpoint_id: 'ep_claude', response_mode: 'joins' }, { endpoint_id: 'ep_codex', response_mode: 'joins' }]; },
    async listRoomMessages() { return { items: [{ room_seq: '1', message_id: 'msg_t', envelope: trigger }], next_after_seq: '1' }; },
    async sendEnvelope(envelope) { sent.push(envelope); return { code: 'ACCEPTED' }; },
    async failRoomInvocation(roomId, reason, invocationId) { failed.push([reason, invocationId]); return {}; },
  };
}

function bridge(relay, cli) {
  const sessions = createSessionStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-br-')), 's.json'));
  const outbox = new LocalOutbox({ privateKey: identityKeys(identity).privateKey, endpoint: { owner_id: identity.owner_id, endpoint_id: identity.endpoint_id, key_id: identity.key_id, kind: identity.kind } });
  return { sessions, instance: createRoomBridge({ identity, relay, outbox, cli, sessions, pollIntervalMs: 20, logger: { warn() {}, error() {} } }) };
}

test('replies in the invocation thread with roster mentions and a stable idempotency key', async () => {
  const relay = fakeRelay();
  let prompt;
  const { instance, sessions } = bridge(relay, { name: 'claude', run: async (input) => { prompt = input.prompt; return { text: 'sure, @ep_codex take it', sessionId: 'sess_1' }; } });
  assert.deepEqual(await instance.handle({ envelope: trigger }), { outcome: 'replied' });
  assert.ok(prompt.startsWith(ROOM_PREAMBLE));
  assert.match(prompt, /\[seq 1\] ep_web: hi @ep_claude/);
  const [reply] = relay.sent;
  assert.equal(reply.message_type, 'room.message');
  assert.deepEqual(reply.broadcast_scope, { conversation_id: 'room_1' });
  assert.equal(reply.recipient, undefined);
  assert.deepEqual(reply.body, { text: 'sure, @ep_codex take it', thread_root_id: 'msg_t', mentions: ['ep_codex'] });
  assert.equal(reply.idempotency_key, 'room_reply_inv_1');
  assert.deepEqual(sessions.get('room_1'), { session_id: 'sess_1', last_seq: '1' });
});

test('skips a delivery whose invocation is no longer running', async () => {
  const relay = fakeRelay({ running: [] });
  const { instance } = bridge(relay, { name: 'claude', run: async () => { throw new Error('must not run'); } });
  assert.deepEqual(await instance.handle({ envelope: trigger }), { outcome: 'skipped' });
});

test('Stop during the run aborts the CLI and posts nothing', async () => {
  const relay = fakeRelay({ runningAfterFirstPoll: [] });
  const cli = { name: 'claude', run: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { code: 'CLI_CANCELLED' })))) };
  const { instance } = bridge(relay, cli);
  assert.deepEqual(await instance.handle({ envelope: trigger }), { outcome: 'cancelled' });
  assert.equal(relay.sent.length, 0);
  assert.equal(relay.failed.length, 0);
});

test('a CLI failure fails the invocation', async () => {
  const relay = fakeRelay();
  const { instance } = bridge(relay, { name: 'claude', run: async () => { throw Object.assign(new Error('boom'), { code: 'CLI_FAILED' }); } });
  assert.deepEqual(await instance.handle({ envelope: trigger }), { outcome: 'failed', reason: 'CLI_FAILED' });
  assert.deepEqual(relay.failed, [['CLI_FAILED', 'inv_1']]);
});

test('resumes the stored session', async () => {
  const relay = fakeRelay();
  const seen = [];
  const { instance, sessions } = bridge(relay, { name: 'claude', run: async (input) => { seen.push(input.sessionId); return { text: 'ok', sessionId: 'sess_1' }; } });
  sessions.set('room_1', { session_id: 'sess_0', last_seq: '0' });
  await instance.handle({ envelope: trigger });
  assert.deepEqual(seen, ['sess_0']);
});
