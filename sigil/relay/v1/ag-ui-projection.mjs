// Match the relay HTTP request body ceiling. Measure the serialized arguments,
// including JSON escapes, in UTF-8 bytes before emitting any tool-call events.
export const MAX_TOOL_CALL_ARGS_BYTES = 1024 * 1024;

function projectEvents(fact, { threadId, runId, assigneeEndpointId, relayConfig }) {
  switch (fact.type) {
    case 'attach.accepted':
      return [{ type: 'RUN_STARTED', threadId, runId, protocolVersion: '1.0' }];
    case 'history.snapshot':
      return [{ type: 'MESSAGES_SNAPSHOT', messages: fact.messages }];
    case 'room.message': {
      const { message_id: messageId, sender, body } = fact.envelope;
      if (assigneeEndpointId == null || sender.endpoint_id !== assigneeEndpointId) return [];
      return [
        { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: body.text },
        { type: 'TEXT_MESSAGE_END', messageId },
      ];
    }
    case 'challenge.created':
      return projectEvents({ type: 'challenges.created', challenges: [{ challenge: fact.challenge, capability: fact.capability }] }, { threadId, runId, assigneeEndpointId, relayConfig });
    case 'challenges.created': {
      const events = [];
      const interrupts = [];
      for (const { challenge, capability } of fact.challenges) {
        const { id, envelope, actionHash, expiresAt } = challenge;
        if (!envelope) continue;
        const delta = JSON.stringify(envelope.body);
        if (Buffer.byteLength(delta, 'utf8') > MAX_TOOL_CALL_ARGS_BYTES) {
          return [{ type: 'RUN_ERROR', message: 'Tool call arguments exceed the relay size limit', code: 'REQUEST_TOO_LARGE' }];
        }
        const toolCallId = envelope.message_id;
        const approvalUrl = new URL('/approve', relayConfig.relayOrigin);
        approvalUrl.searchParams.set('challenge', id);
        events.push(
          { type: 'TOOL_CALL_START', toolCallId, toolCallName: capability },
          { type: 'TOOL_CALL_ARGS', toolCallId, delta },
          { type: 'TOOL_CALL_END', toolCallId },
        );
        interrupts.push({
          id,
          reason: 'confirmation',
          toolCallId,
          expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
          metadata: { sigil: { action_hash: actionHash, approval_url: approvalUrl.href } },
        });
      }
      if (interrupts.length) events.push({ type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'interrupt', interrupts } });
      return events;
    }
    case 'gated-envelope.accepted': {
      const { messageId, toolCallId, content } = fact;
      return [{ type: 'TOOL_CALL_RESULT', messageId, toolCallId, content }];
    }
    case 'receipt.written': {
      const { receipt_id, signature, stream_seq, room_seq } = fact.receipt;
      return [{ type: 'CUSTOM', name: 'sigil.receipt', value: { receipt_id, signature, stream_seq, room_seq } }];
    }
    case 'task.result.accepted':
      return [{ type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'success' } }];
    case 'rejection':
      return [{ type: 'RUN_ERROR', message: fact.message, code: fact.code }];
    default:
      return [];
  }
}

/**
 * Project a validated relay fact for one attached task. The caller scopes facts
 * to the task, supplies history in AG-UI message form, and identifies which
 * capability triggered a bound challenge. relayConfig.relayOrigin comes from
 * trusted relay configuration.
 *
 * Start with { threadId, runId, assigneeEndpointId, relayConfig, terminal: false }
 * and pass the returned state to each subsequent call for that run. The first
 * terminal event closes the run. Each fact may supply a timestamp in epoch ms.
 */
export function projectRelayFact(fact, state) {
  if (state.terminal) return { events: [], state };

  const projected = projectEvents(fact, state);
  const lastType = projected.at(-1)?.type;
  const terminal = lastType === 'RUN_FINISHED' || lastType === 'RUN_ERROR';
  const events = fact.timestamp === undefined
    ? projected
    : projected.map(event => ({ ...event, timestamp: fact.timestamp }));
  return { events, state: terminal ? { ...state, terminal: true } : state };
}
