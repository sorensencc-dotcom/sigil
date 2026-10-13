import { WebSocketServer } from 'ws';
import { createBearerAuthenticator } from './transport-auth.mjs';
import { isAllowedOrigin } from './browser-cors.mjs';
import { isSocketLive } from './liveness.mjs';

function streamSequenceValue(value) {
  return value == null ? null : String(value);
}

function sequenceFrame(type, payload = {}) {
  const { streamSeq, stream_seq, ...frame } = payload;
  return { type, ...frame, stream_seq: streamSequenceValue(streamSeq ?? stream_seq) };
}

export function createStreamServer({ server, authenticate, tokenHashes, ticketStore = null, allowedOrigins = [], logger = null, repository = null, livenessIntervalMs = 60_000 } = {}) {
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
  // socket -> { endpointId, ownerId }, so revalidate can select a human's sockets.
  const socketInfo = new WeakMap();
  const checksLiveness = typeof repository?.livenessSnapshot === 'function';
  // Resolves the snapshot when live, null otherwise. A failed read fails closed.
  const liveSnapshot = async (endpointId) => {
    if (!checksLiveness) return {};
    try {
      const snapshot = await repository.livenessSnapshot({ endpointId });
      return isSocketLive(snapshot) ? snapshot : null;
    } catch (error) {
      logger?.warn?.({ event: 'stream.liveness_read_failed', endpoint_id: endpointId, error: error?.message });
      return null;
    }
  };
  const register = (map, endpointId, socket) => {
    if (!map.has(endpointId)) map.set(endpointId, new Set());
    map.get(endpointId).add(socket);
    socket.on('close', () => {
      const sockets = map.get(endpointId);
      if (!sockets) return;
      sockets.delete(socket);
      if (!sockets.size) map.delete(endpointId);
    });
  };
  const handleConnection = async (socket, request) => {
    // A malformed frame makes ws emit 'error'; without a listener that throws and kills the relay.
    socket.on('error', () => socket.terminate());
    socket.on('message', (raw) => {
      let message; try { message = JSON.parse(raw); } catch { return; }
      if (message?.type === 'ping') socket.send(JSON.stringify({ type: 'pong', timestamp: message.timestamp }));
    });
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
    let principal;
    if (ticketParam !== null) {
      if (!ticketPrincipal) return socket.close(1008, 'unauthorized');
      principal = ticketPrincipal;
    } else {
      principal = await authenticateRequest(request);
    }
    const endpointId = typeof principal === 'string' ? principal : principal?.endpoint_id;
    if (!endpointId) return socket.close(1008, 'unauthorized');
    // The socket joins clients/browserClients only after liveness passes, so
    // no frame reaches a socket whose endpoint or human is not live.
    const snapshot = await liveSnapshot(endpointId);
    if (!snapshot) return socket.close(1008, 'unauthorized');
    if (socket.readyState !== 1) return;
    socketInfo.set(socket, { endpointId, ownerId: snapshot.owner_id ?? principal?.owner_id ?? null });
    register(ticketParam !== null ? browserClients : clients, endpointId, socket);
  };
  wss.on('connection', (socket, request) => {
    handleConnection(socket, request).catch((error) => {
      logger?.error?.({ event: 'stream.upgrade_failed', error: error?.message });
      socket.close(1008, 'unauthorized');
    });
  });
  // One snapshot read per endpoint; every failing socket closes 1008.
  const recheck = async (sockets) => {
    const byEndpoint = new Map();
    for (const socket of sockets) {
      const info = socketInfo.get(socket);
      if (!info || socket.readyState !== 1) continue;
      if (!byEndpoint.has(info.endpointId)) byEndpoint.set(info.endpointId, []);
      byEndpoint.get(info.endpointId).push(socket);
    }
    for (const [endpointId, group] of byEndpoint) {
      if (await liveSnapshot(endpointId)) continue;
      for (const socket of group) socket.close(1008, 'unauthorized');
    }
  };
  const allSockets = () => [...clients.values(), ...browserClients.values()].flatMap((set) => [...set]);
  let passRunning = false;
  const livenessTimer = checksLiveness ? setInterval(async () => {
    if (passRunning) return;
    passRunning = true;
    try { await recheck(allSockets()); } finally { passRunning = false; }
  }, livenessIntervalMs) : null;
  livenessTimer?.unref?.();
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
    async revalidate({ humanId, endpointId } = {}) {
      if (!humanId && !endpointId) return;
      await recheck(allSockets().filter((socket) => {
        const info = socketInfo.get(socket);
        return info && ((endpointId && info.endpointId === endpointId) || (humanId && info.ownerId === humanId));
      }));
    },
    close() {
      if (livenessTimer) clearInterval(livenessTimer);
      return new Promise((resolve) => wss.close(resolve));
    }
  };
}
