import { WebSocketServer } from 'ws';

export function createStreamServer({ server, authenticate = () => null } = {}) {
  const wss = new WebSocketServer({ server, path: '/v1/stream' });
  const clients = new Map();
  wss.on('connection', (socket, request) => {
    const endpointId = authenticate(request);
    if (!endpointId) return socket.close(1008, 'unauthorized');
    clients.set(endpointId, socket);
    socket.on('close', () => { if (clients.get(endpointId) === socket) clients.delete(endpointId); });
  });
  return {
    notify(endpointId, deliveryId) {
      const socket = clients.get(endpointId);
      if (!socket || socket.readyState !== 1) return false;
      socket.send(JSON.stringify({ type: 'delivered', delivery_id: deliveryId }));
      return true;
    },
    close() { return new Promise((resolve) => wss.close(resolve)); }
  };
}
