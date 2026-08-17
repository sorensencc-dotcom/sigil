import { WebSocketServer } from 'ws';
import { createBearerAuthenticator } from './transport-auth.mjs';

export function createStreamServer({ server, authenticate, tokenHashes } = {}) {
  const authenticateRequest = authenticate ?? (tokenHashes ? createBearerAuthenticator(tokenHashes) : () => null);
  const wss = new WebSocketServer({ server, path: '/v1/stream' });
  const clients = new Map();
  wss.on('connection', (socket, request) => {
    const principal = authenticateRequest(request);
    const endpointId = typeof principal === 'string' ? principal : principal?.endpoint_id;
    if (!endpointId) return socket.close(1008, 'unauthorized');
    clients.set(endpointId, socket);
    socket.on('message', (raw) => {
      let message; try { message = JSON.parse(raw); } catch { return; }
      if (message?.type === 'ping') socket.send(JSON.stringify({ type: 'pong', timestamp: message.timestamp }));
    });
    socket.on('close', () => { if (clients.get(endpointId) === socket) clients.delete(endpointId); });
  });
  return {
    notify(endpointId, deliveryId) {
      const socket = clients.get(endpointId);
      if (!socket || socket.readyState !== 1) return false;
      socket.send(JSON.stringify({ type: 'delivered', delivery_id: deliveryId }));
      return true;
    },
    notifyReceipt(endpointId, receipt) {
      const socket = clients.get(endpointId);
      if (!socket || socket.readyState !== 1) return false;
      socket.send(JSON.stringify({ type: 'delivery.receipt', ...receipt }));
      return true;
    },
    close() { return new Promise((resolve) => wss.close(resolve)); }
  };
}
