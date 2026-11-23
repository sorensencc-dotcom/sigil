import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_TOOL_CALL_ARGS_BYTES, projectRelayFact } from './ag-ui-projection.mjs';

const run = Object.freeze({
  threadId: 'conversation-1',
  runId: 'run-1',
  assigneeEndpointId: 'worker-1',
  relayConfig: Object.freeze({ relayOrigin: 'https://relay.example' }),
  terminal: false,
});
const runIds = { threadId: 'conversation-1', runId: 'run-1' };
const actionHash = 'ab'.repeat(32);
const expiresAt = '2026-11-21T23:23:00.000Z';
const challengeCreated = {
  type: 'challenge.created',
  capability: 'deploy',
  challenge: {
    id: 'challenge-1',
    actionHash,
    expiresAt,
    envelope: {
      message_id: 'tool-1',
      body: { target: 'staging' },
    },
  },
};
const taskResult = { type: 'task.result.accepted' };
const rejection = { type: 'rejection', message: 'Approval expired', code: 'APPROVAL_EXPIRED' };
const attach = { type: 'attach.accepted' };
const progress = {
  type: 'room.message',
  envelope: {
    message_id: 'message-1',
    sender: { endpoint_id: 'worker-1' },
    body: { text: 'Building.\nTests are next.' },
  },
};

const section7Cases = [
  {
    name: 'attach accepted',
    fact: attach,
    events: [{ type: 'RUN_STARTED', ...runIds, protocolVersion: '1.0' }],
  },
  {
    name: 'history snapshot preserves message order and roles',
    fact: {
      type: 'history.snapshot',
      messages: [
        { id: 'message-0', role: 'user', content: 'Build the project' },
        { id: 'message-1', role: 'assistant', content: 'Building now' },
      ],
    },
    events: [{
      type: 'MESSAGES_SNAPSHOT',
      messages: [
        { id: 'message-0', role: 'user', content: 'Build the project' },
        { id: 'message-1', role: 'assistant', content: 'Building now' },
      ],
    }],
  },
  {
    name: 'assignee room message uses a single delta',
    fact: progress,
    events: [
      { type: 'TEXT_MESSAGE_START', messageId: 'message-1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'message-1', delta: 'Building.\nTests are next.' },
      { type: 'TEXT_MESSAGE_END', messageId: 'message-1' },
    ],
  },
  {
    name: 'bound challenge announces the tool and interrupts the run',
    fact: challengeCreated,
    events: [
      { type: 'TOOL_CALL_START', toolCallId: 'tool-1', toolCallName: 'deploy' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'tool-1', delta: '{"target":"staging"}' },
      { type: 'TOOL_CALL_END', toolCallId: 'tool-1' },
      {
        type: 'RUN_FINISHED',
        ...runIds,
        outcome: {
          type: 'interrupt',
          interrupts: [{
            id: 'challenge-1',
            reason: 'confirmation',
            toolCallId: 'tool-1',
            expiresAt: '2026-11-21T23:23:00.000Z',
            metadata: {
              sigil: {
                action_hash: 'ab'.repeat(32),
                approval_url: 'https://relay.example/approve?challenge=challenge-1',
              },
            },
          }],
        },
      },
    ],
  },
  {
    name: 'gated envelope accepted',
    fact: { type: 'gated-envelope.accepted', messageId: 'tool-result-1', toolCallId: 'tool-1', content: 'Accepted' },
    events: [{ type: 'TOOL_CALL_RESULT', messageId: 'tool-result-1', toolCallId: 'tool-1', content: 'Accepted' }],
  },
  {
    name: 'signed receipt emits only the projected fields',
    fact: {
      type: 'receipt.written',
      receipt: { receipt_id: 'receipt-1', signature: 'sig-1', stream_seq: '19', room_seq: '8', message_id: 'tool-1' },
    },
    events: [{
      type: 'CUSTOM',
      name: 'sigil.receipt',
      value: { receipt_id: 'receipt-1', signature: 'sig-1', stream_seq: '19', room_seq: '8' },
    }],
  },
  {
    name: 'task.result accepted succeeds',
    fact: taskResult,
    events: [{ type: 'RUN_FINISHED', ...runIds, outcome: { type: 'success' } }],
  },
  {
    name: 'rejection retains the relay error',
    fact: rejection,
    events: [{ type: 'RUN_ERROR', message: 'Approval expired', code: 'APPROVAL_EXPIRED' }],
  },
];

for (const { name, fact, events } of section7Cases) {
  test(name, () => {
    assert.deepEqual(projectRelayFact(fact, run).events, events);
  });
}

test('challenge without an envelope leaves the run open', () => {
  const fact = { type: 'challenge.created', challenge: { id: 'challenge-legacy', actionHash, expiresAt } };
  const result = projectRelayFact(fact, run);
  assert.deepEqual(result.events, []);
  assert.equal(result.state.terminal, false);
  assert.deepEqual(projectRelayFact(taskResult, result.state).events, [
    { type: 'RUN_FINISHED', ...runIds, outcome: { type: 'success' } },
  ]);
});

test('room messages from other endpoints produce no progress', () => {
  const fact = {
    ...progress,
    envelope: { ...progress.envelope, sender: { endpoint_id: 'other-worker' } },
  };
  assert.deepEqual(projectRelayFact(fact, run).events, []);
});

test('interrupt link uses the configured relay origin and the encoded challenge id', () => {
  const fact = {
    ...challengeCreated,
    relayConfig: { relayOrigin: 'https://worker.example' },
    challenge: {
      ...challengeCreated.challenge,
      id: 'id&cb=https://worker.example',
      expiresAt: new Date(expiresAt),
      approvalUrl: 'https://client.example/approve',
      callbackUrl: 'http://localhost:8080/callback',
    },
  };
  const interrupt = projectRelayFact(fact, run).events.at(-1).outcome.interrupts[0];
  assert.equal(interrupt.expiresAt, expiresAt);
  assert.equal(interrupt.metadata.sigil.approval_url, 'https://relay.example/approve?challenge=id%26cb%3Dhttps%3A%2F%2Fworker.example');
});

function challengeWithBody(body) {
  return {
    ...challengeCreated,
    challenge: {
      ...challengeCreated.challenge,
      envelope: { ...challengeCreated.challenge.envelope, body },
    },
  };
}

test('tool arguments round-trip quotes, backslashes and control characters', () => {
  const body = { text: 'say "hi"\\path\n\t\u0000\r' };
  const args = projectRelayFact(challengeWithBody(body), run).events[1];
  assert.equal(args.delta, String.raw`{"text":"say \"hi\"\\path\n\t\u0000\r"}`);
  assert.deepEqual(JSON.parse(args.delta), body);
});

test('tool arguments accept the byte ceiling and fail atomically one UTF-8 byte over it', () => {
  const overhead = Buffer.byteLength('{"text":""}', 'utf8');
  const text = 'é'.repeat((MAX_TOOL_CALL_ARGS_BYTES - overhead - 1) / 2) + 'a';
  const atLimit = projectRelayFact(challengeWithBody({ text }), run);
  assert.equal(Buffer.byteLength(atLimit.events[1].delta, 'utf8'), MAX_TOOL_CALL_ARGS_BYTES);
  assert.equal(atLimit.events.at(-1).outcome.type, 'interrupt');

  const oversized = projectRelayFact(challengeWithBody({ text: text + 'b' }), run);
  assert.deepEqual(oversized.events, [{
    type: 'RUN_ERROR',
    code: 'REQUEST_TOO_LARGE',
    message: 'Tool call arguments exceed the relay size limit',
  }]);
  assert.deepEqual(projectRelayFact(taskResult, oversized.state).events, []);
});

test('a fact supplies the timestamp for every event it produces', () => {
  const timestamp = 1795303080000;
  const { events } = projectRelayFact({ ...progress, timestamp }, run);
  assert.deepEqual(events.map(event => event.timestamp), [timestamp, timestamp, timestamp]);
});

for (const terminalFact of [challengeCreated, taskResult, rejection]) {
  test(`${terminalFact.type} closes the run exactly once`, () => {
    const facts = [attach, terminalFact, terminalFact, rejection, taskResult, challengeCreated, progress];
    const events = [];
    let state = run;
    for (const fact of facts) {
      const result = projectRelayFact(fact, state);
      events.push(...result.events);
      state = result.state;
    }
    assert.deepEqual(events, [
      ...section7Cases.find(entry => entry.fact === attach).events,
      ...section7Cases.find(entry => entry.fact === terminalFact).events,
    ]);
    assert.equal(state.terminal, true);
    assert.equal(run.terminal, false);
    assert.deepEqual(projectRelayFact(attach, { ...run, runId: 'run-2' }).events, [
      { type: 'RUN_STARTED', threadId: 'conversation-1', runId: 'run-2', protocolVersion: '1.0' },
    ]);
  });
}

test('multiple challenges from one interrupted run share one interrupt terminal event', () => {
  const result = projectRelayFact({
    type: 'challenges.created',
    challenges: [
      { challenge: challengeCreated.challenge, capability: 'deploy' },
      { challenge: { ...challengeCreated.challenge, id: 'challenge-2', envelope: { message_id: 'tool-2', body: { target: 'production' } } }, capability: 'publish' },
    ],
  }, run);
  const terminal = result.events.filter((event) => event.type === 'RUN_FINISHED');
  assert.equal(terminal.length, 1);
  assert.deepEqual(terminal[0].outcome.interrupts.map((interrupt) => interrupt.id), ['challenge-1', 'challenge-2']);
  assert.deepEqual(result.events.filter((event) => event.type === 'TOOL_CALL_START').map((event) => event.toolCallId), ['tool-1', 'tool-2']);
});
