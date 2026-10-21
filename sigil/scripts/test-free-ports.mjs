import net from 'node:net';

const DERIVED_OFFSETS = [1, 2, 5];
const POOL_PER_PORT = 8;

function listen() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const close = (server) => new Promise((resolve) => server.close(resolve));

function collides(port, others) {
  return others.some((other) => port === other || DERIVED_OFFSETS.some((offset) => port === other + offset || other === port + offset));
}

function pick(candidates, count) {
  const chosen = [];
  for (const port of candidates) {
    if (!collides(port, chosen)) chosen.push(port);
    if (chosen.length === count) return chosen;
  }
  return null;
}

export async function freeDistinctPorts(count, { attempts = 20 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const servers = [];
    try {
      for (let i = 0; i < count * POOL_PER_PORT; i += 1) servers.push(await listen());
      const chosen = pick(servers.map((server) => server.address().port), count);
      if (chosen) return chosen;
    } finally {
      await Promise.all(servers.map(close));
    }
  }
  throw new Error(`could not allocate ${count} distinct ports with clear +${DERIVED_OFFSETS.join('/+')} neighbours`);
}
