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

export function createStreamServer({ server, authenticate, tokenHashes, ticketStore = null, allowedOrigins = [], logger = null, repository = null, livenessIntervalMs = 60_000, publicServer = null, publicOrigin = null } = {}) {
  const authenticateRequest = authenticate ?? (tokenHashes ? createBearerAuthenticator(tokenHashes) : () => null);
  const wss = new WebSocketServer({ server, path: '/v1/stream' });
  // The public (cookie-login) listener is ticket-only. It shares every socket
  // index below, so frames reach its sockets exactly like loopback ones.
  const publicWss = publicServer ? new WebSocketServer({ server: publicServer, path: '/v1/stream' }) : null;
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
  // socket -> { endpointId, ownerId, sessionId }, so revalidate can select a
  // human's sockets. sessionId is null for bearer and token-mode ticket sockets.
  const socketInfo = new WeakMap();
  // session_id -> Set<socket>, so closeSession (logout, revoke) reaches them.
  const sessionSockets = new Map();
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
  // null: no session to check. false: the session is dead (row gone, read
  // failed, or the repository cannot read sessions). Otherwise the session row.
  const liveSession = async (sessionId) => {
    if (!sessionId) return null;
    if (typeof repository?.sessionLiveness !== 'function') return false;
    try { return (await repository.sessionLiveness(sessionId)) ?? false; } catch (error) {
      logger?.warn?.({ event: 'stream.session_read_failed', error: error?.message });
      return false;
    }
  };
  // isSocketLive skips the identity and idle checks when those fields are
  // absent, so a session row lacking them is treated as dead here.
  const sessionOk = (snapshot, session) => session === null || (
    session !== false && session.last_seen_at != null && session.identity_status != null
    && isSocketLive(checksLiveness ? snapshot : null, session));
  const trackSession = (sessionId, socket) => {
    if (!sessionSockets.has(sessionId)) sessionSockets.set(sessionId, new Set());
    sessionSockets.get(sessionId).add(socket);
    socket.on('close', () => {
      const sockets = sessionSockets.get(sessionId);
      if (!sockets) return;
      sockets.delete(socket);
      if (!sockets.size) sessionSockets.delete(sessionId);
    });
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
  const handleConnection = async (socket, request, { ticketOnly = false } = {}) => {
    // A malformed frame makes ws emit 'error'; without a listener that throws and kills the relay.
    socket.on('error', () => socket.terminate());
    socket.on('message', (raw) => {
      let message; try { message = JSON.parse(raw); } catch { return; }
      if (message?.type === 'ping') socket.send(JSON.stringify({ type: 'pong', timestamp: message.timestamp }));
    });
    // Never log request.url: for /v1/stream it can carry a ticket.
    const ticketParam = new URL(request.url, 'http://localhost').searchParams.get('ticket');
    let principal;
    if (ticketOnly) {
      // Public listener: a ticket plus the exact public Origin, nothing else.
      // Authorization and the sigil-bearer. subprotocol are never read here.
      // Redeem first so a ticket is spent even when the origin check fails.
      const spent = ticketParam !== null ? (ticketStore?.redeem(ticketParam) ?? null) : null;
      if (publicOrigin === null || request.headers.origin !== publicOrigin || !spent) return socket.close(1008, 'unauthorized');
      principal = spent;
    } else {
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
        principal = ticketPrincipal;
      } else {
        principal = await authenticateRequest(request);
      }
    }
    const endpointId = typeof principal === 'string' ? principal : principal?.endpoint_id;
    if (!endpointId) return socket.close(1008, 'unauthorized');
    const sessionId = ticketParam !== null ? (principal?.session_id ?? null) : null;
    // Tracked before the async checks, so a closeSession that lands while this
    // upgrade is still being checked closes it too.
    if (sessionId) trackSession(sessionId, socket);
    // The socket joins clients/browserClients only after liveness passes, so
    // no frame reaches a socket whose endpoint, human, or session is not live.
    const snapshot = await liveSnapshot(endpointId);
    if (!snapshot) return socket.close(1008, 'unauthorized');
    if (!sessionOk(snapshot, await liveSession(sessionId))) return socket.close(1008, 'unauthorized');
    if (socket.readyState !== 1) return;
    socketInfo.set(socket, { endpointId, ownerId: snapshot.owner_id ?? principal?.owner_id ?? null, sessionId });
    register(ticketParam !== null ? browserClients : clients, endpointId, socket);
  };
  wss.on('connection', (socket, request) => {
    handleConnection(socket, request).catch((error) => {
      logger?.error?.({ event: 'stream.upgrade_failed', error: error?.message });
      socket.close(1008, 'unauthorized');
    });
  });
  publicWss?.on('connection', (socket, request) => {
    handleConnection(socket, request, { ticketOnly: true }).catch((error) => {
      logger?.error?.({ event: 'stream.upgrade_failed', error: error?.message });
      socket.close(1008, 'unauthorized');
    });
  });
  // One snapshot read per endpoint and one session read per session; every
  // failing socket closes 1008.
  const recheck = async (sockets) => {
    const byEndpoint = new Map();
    for (const socket of sockets) {
      const info = socketInfo.get(socket);
      if (!info || socket.readyState !== 1) continue;
      if (!byEndpoint.has(info.endpointId)) byEndpoint.set(info.endpointId, []);
      byEndpoint.get(info.endpointId).push(socket);
    }
    const sessions = new Map();
    for (const [endpointId, group] of byEndpoint) {
      const snapshot = await liveSnapshot(endpointId);
      for (const socket of group) {
        const { sessionId } = socketInfo.get(socket);
        if (snapshot && sessionId && !sessions.has(sessionId)) sessions.set(sessionId, await liveSession(sessionId));
        if (snapshot && sessionOk(snapshot, sessionId ? sessions.get(sessionId) : null)) continue;
        socket.close(1008, 'unauthorized');
      }
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
    // Closes every open (or still-upgrading) socket bound to this session.
    closeSession(sessionId, code = 1008) {
      if (!sessionId) return 0;
      const sockets = [...(sessionSockets.get(sessionId) ?? [])].filter((socket) => socket.readyState === 0 || socket.readyState === 1);
      for (const socket of sockets) socket.close(code, 'unauthorized');
      return sockets.length;
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
      return Promise.all([wss, publicWss].filter(Boolean).map((ws) => new Promise((resolve) => ws.close(resolve))));
    }
  };
}
