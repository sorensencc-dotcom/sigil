const DEFAULT_CONFIG = Object.freeze({
  maxBuffer: 200,
  retryDelaysMs: [60_000, 300_000, 1_800_000],
  maxRetries: 4,
});

function keyOf(conversationId, senderEndpointId) {
  return `${conversationId}\u0000${senderEndpointId}`;
}

function sequenceOf(value) {
  return Number.isSafeInteger(value) ? value : Number(value);
}

export function createStreamGapTracker({
  loadHighWater = async () => null,
  saveHighWater = async () => {},
  sendResendRequest = async () => {},
  onEnvelope = () => {},
  onEvent = () => {},
  now = () => new Date(),
  config: configOverrides = {},
} = {}) {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  const streams = new Map();

  async function stateFor(conversationId, senderEndpointId) {
    const key = keyOf(conversationId, senderEndpointId);
    let state = streams.get(key);
    if (!state) {
      const stored = await loadHighWater(conversationId, senderEndpointId);
      state = { conversationId, senderEndpointId, lastContiguousSeq: Number.isSafeInteger(stored) ? stored : 0, buffer: new Map(), outstanding: null };
      streams.set(key, state);
    }
    return state;
  }

  async function persist(state) {
    await saveHighWater(state.conversationId, state.senderEndpointId, state.lastContiguousSeq);
  }

  function release(state, envelope) {
    onEnvelope(envelope);
    return envelope;
  }

  async function requestGap(state, from, to) {
    if (state.outstanding) return;
    state.outstanding = { from, to, retries: 0 };
    await sendResendRequest({ target_sender_endpoint_id: state.senderEndpointId, conversation_id: state.conversationId, begin_seq: from, end_seq: to });
  }

  async function drain(state) {
    while (state.buffer.has(state.lastContiguousSeq + 1)) {
      const next = state.buffer.get(state.lastContiguousSeq + 1);
      state.buffer.delete(state.lastContiguousSeq + 1);
      state.lastContiguousSeq += 1;
      release(state, next);
    }
    if (!state.buffer.size) state.outstanding = null;
    await persist(state);
  }

  async function unrecoverable(state, from, to) {
    const buffered = [...state.buffer.entries()].sort(([a], [b]) => a - b);
    state.buffer.clear();
    onEvent({ type: 'unrecoverable_gap', conversation_id: state.conversationId, sender_endpoint_id: state.senderEndpointId, missing_seq_from: from, missing_seq_to: to });
    for (const [, envelope] of buffered) release(state, envelope);
    state.lastContiguousSeq = Math.max(to, buffered.length ? buffered[buffered.length - 1][0] : 0);
    state.outstanding = null;
    await persist(state);
  }

  async function receive(envelope, frame = {}) {
    const value = envelope?.envelope ?? envelope;
    const seq = sequenceOf(frame.stream_seq ?? frame.streamSeq ?? value?.stream_seq ?? value?.streamSeq);
    if (!Number.isSafeInteger(seq)) { release(null, value); return { status: 'unsequenced' }; }
    const state = await stateFor(value.conversation_id, value.sender?.endpoint_id);
    if (seq <= state.lastContiguousSeq) return { status: 'duplicate' };
    if (seq === state.lastContiguousSeq + 1) { state.lastContiguousSeq = seq; release(state, value); await drain(state); return { status: 'delivered' }; }
    if (!state.buffer.has(seq)) state.buffer.set(seq, value);
    if (state.buffer.size > config.maxBuffer) await unrecoverable(state, state.lastContiguousSeq + 1, seq - 1);
    else await requestGap(state, state.lastContiguousSeq + 1, seq - 1);
    return { status: 'buffered', missingFrom: state.lastContiguousSeq + 1, missingTo: seq - 1 };
  }

  async function receiveReset(frame) {
    const state = await stateFor(frame.conversation_id, frame.target_sender_endpoint_id ?? frame.sender_endpoint_id);
    const from = state.lastContiguousSeq + 1;
    state.lastContiguousSeq = sequenceOf(frame.new_seq) - 1;
    onEvent({ type: 'sequence_reset', ...frame });
    const buffered = [...state.buffer.entries()].sort(([left], [right]) => left - right);
    state.buffer.clear();
    for (const [, envelope] of buffered) release(state, envelope);
    if (buffered.length) state.lastContiguousSeq = Math.max(state.lastContiguousSeq, buffered[buffered.length - 1][0]);
    await persist(state);
    state.outstanding = null;
    return { status: 'reset', missingFrom: from, missingTo: state.lastContiguousSeq };
  }

  async function retry(conversationId, senderEndpointId) {
    const state = await stateFor(conversationId, senderEndpointId);
    if (!state.outstanding) return false;
    state.outstanding.retries += 1;
    if (state.outstanding.retries >= config.maxRetries) { await unrecoverable(state, state.outstanding.from, state.outstanding.to); return false; }
    await sendResendRequest({ target_sender_endpoint_id: senderEndpointId, conversation_id: conversationId, begin_seq: state.outstanding.from, end_seq: state.outstanding.to });
    return true;
  }

  function snapshot() {
    return [...streams.values()].map((state) => ({
      conversation_id: state.conversationId,
      sender_endpoint_id: state.senderEndpointId,
      last_contiguous_seq: state.lastContiguousSeq,
      buffered: [...state.buffer.values()],
      missing: state.outstanding ? { from: state.outstanding.from, to: state.outstanding.to } : null,
      outstanding: state.outstanding,
    }));
  }

  return { receive, receiveReset, retry, snapshot };
}
