import { WebSocketServer } from 'ws';
import { createBearerAuthenticator } from './transport-auth.mjs';

function streamSequenceValue(value) {
  return value == null ? null : String(value);
}

function sequenceFrame(type, payload = {}) {
  const { streamSeq, stream_seq, ...frame } = payload;
  return { type, ...frame, stream_seq: streamSequenceValue(streamSeq ?? stream_seq) };
}

export function createStreamServer({ server, authenticate, tokenHashes } = {}) {
  const authenticateRequest = authenticate ?? (tokenHashes ? createBearerAuthenticator(tokenHashes) : () => null);
  const wss = new WebSocketServer({ server, path: '/v1/stream' });
  // endpoint_id -> Set<socket>, in connection order. A closing socket removes
  // only itself, so a listener connected earlier keeps working.
  const clients = new Map();
  const openSockets = (endpointId) => [...(clients.get(endpointId) ?? [])].filter((socket) => socket.readyState === 1);
  // Receipts (and later room updates) are idempotent hints: every client may see them.
  const notifyAll = (endpointId, frame) => {
    const sockets = openSockets(endpointId);
    if (!sockets.length) return false;
    const raw = JSON.stringify(frame);
    for (const socket of sockets) socket.send(raw);
    return true;
  };
  // delivered / resend / sequence_reset drive a client's inbox or sequence
  // state, so exactly one client (the most recently connected open socket)
  // acts on each. When it closes, the previous open socket becomes latest.
  const notifyLatest = (endpointId, frame) => {
    const sockets = openSockets(endpointId);
    if (!sockets.length) return false;
    sockets[sockets.length - 1].send(JSON.stringify(frame));
    return true;
  };
  wss.on('connection', (socket, request) => {
    const principal = authenticateRequest(request);
    const endpointId = typeof principal === 'string' ? principal : principal?.endpoint_id;
    if (!endpointId) return socket.close(1008, 'unauthorized');
    if (!clients.has(endpointId)) clients.set(endpointId, new Set());
    clients.get(endpointId).add(socket);
    socket.on('message', (raw) => {
      let message; try { message = JSON.parse(raw); } catch { return; }
      if (message?.type === 'ping') socket.send(JSON.stringify({ type: 'pong', timestamp: message.timestamp }));
    });
    socket.on('close', () => {
      const sockets = clients.get(endpointId);
      if (!sockets) return;
      sockets.delete(socket);
      if (!sockets.size) clients.delete(endpointId);
    });
  });
  return {
    notify(endpointId, deliveryId, streamSeq = null) {
      return notifyLatest(endpointId, sequenceFrame('delivered', { delivery_id: deliveryId, streamSeq }));
    },
    notifyReceipt(endpointId, receipt) {
      return notifyAll(endpointId, sequenceFrame('delivery.receipt', receipt));
    },
    notifyResend(endpointId, payload) {
      return notifyLatest(endpointId, sequenceFrame('resend', payload));
    },
    notifySequenceReset(endpointId, payload) {
      return notifyLatest(endpointId, sequenceFrame('sequence_reset', payload));
    },
    close() { return new Promise((resolve) => wss.close(resolve)); }
  };
}
