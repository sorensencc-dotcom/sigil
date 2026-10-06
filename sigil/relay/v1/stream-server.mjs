import { WebSocketServer } from 'ws';
import { createBearerAuthenticator } from './transport-auth.mjs';
import { isAllowedOrigin } from './browser-cors.mjs';

function streamSequenceValue(value) {
  return value == null ? null : String(value);
}

function sequenceFrame(type, payload = {}) {
  const { streamSeq, stream_seq, ...frame } = payload;
  return { type, ...frame, stream_seq: streamSequenceValue(streamSeq ?? stream_seq) };
}

export function createStreamServer({ server, authenticate, tokenHashes, ticketStore = null, allowedOrigins = [], logger = null } = {}) {
  const authenticateRequest = authenticate ?? (tokenHashes ? createBearerAuthenticator(tokenHashes) : () => null);
  const wss = new WebSocketServer({ server, path: '/v1/stream' });
  // endpoint_id -> Set<socket>, in connection order. A closing socket removes
  // only itself, so a listener connected earlier keeps working.
  const clients = new Map();
  // endpoint_id -> Set<socket> for ticket (browser) sockets. Kept apart from
  // `clients` so a browser socket never becomes the latest socket for
  // delivered, resend, or sequence_reset.
  const browserClients = new Map();
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
    // A malformed frame makes ws emit 'error'; without a listener that throws and kills the relay.
    socket.on('error', () => socket.terminate());
    // Never log request.url: for /v1/stream it can carry a ticket.
    const ticketParam = new URL(request.url, 'http://localhost').searchParams.get('ticket');
    // Redeem first so a ticket is spent even when the origin check then fails.
    const ticketPrincipal = ticketParam !== null ? (ticketStore?.redeem(ticketParam) ?? null) : null;
    // Origin is checked on EVERY upgrade, ticket or bearer. A browser sends Origin
    // on all of them (including the sigil-bearer. subprotocol path), so a bearer
    // upgrade from a disallowed web origin is refused too. No Origin header
    // (CLI and agent clients) skips the check.
    const origin = request.headers.origin;
    if (origin !== undefined && !isAllowedOrigin(origin, allowedOrigins)) return socket.close(1008, 'unauthorized');
    if (ticketParam !== null) {
      if (!ticketPrincipal) return socket.close(1008, 'unauthorized');
      const endpointId = ticketPrincipal.endpoint_id;
      if (!browserClients.has(endpointId)) browserClients.set(endpointId, new Set());
      browserClients.get(endpointId).add(socket);
      socket.on('message', (raw) => {
        let message; try { message = JSON.parse(raw); } catch { return; }
        if (message?.type === 'ping') socket.send(JSON.stringify({ type: 'pong', timestamp: message.timestamp }));
      });
      socket.on('close', () => {
        const sockets = browserClients.get(endpointId);
        sockets?.delete(socket);
        if (sockets && !sockets.size) browserClients.delete(endpointId);
      });
      return;
    }
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
    notifyRoom(endpointId, { room_id, room_seq, changed }) {
      // room.updated is an idempotent hint: every open socket on the endpoint
      // gets it, bearer and browser (receipts spec, Part 2 frame table).
      const sockets = [...openSockets(endpointId), ...[...(browserClients.get(endpointId) ?? [])].filter((socket) => socket.readyState === 1)];
      if (!sockets.length) return false;
      const frame = JSON.stringify({ type: 'room.updated', room_id, ...(room_seq == null ? {} : { room_seq }), changed });
      for (const socket of sockets) socket.send(frame);
      return true;
    },
    close() { return new Promise((resolve) => wss.close(resolve)); }
  };
}
