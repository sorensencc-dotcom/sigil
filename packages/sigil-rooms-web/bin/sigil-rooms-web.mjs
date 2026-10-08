#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createWebServer, defaultStreamUrl } from '../serve/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '5173' },
    'relay-url': { type: 'string', default: 'http://127.0.0.1:7777' },
    'stream-url': { type: 'string' },
    dist: { type: 'string', default: path.resolve(here, '../dist') },
  },
});

const port = Number(values.port);
const relayUrl = values['relay-url'].replace(/\/$/, '');
const streamUrl = (values['stream-url'] ?? defaultStreamUrl(relayUrl)).replace(/\/$/, '');
const distDir = path.resolve(values.dist);

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error(`sigil-rooms-web: no build at ${distDir}. Run npm run build first.`);
  process.exit(1);
}

const server = createWebServer({ distDir, relayUrl, streamUrl });
server.on('error', (error) => {
  console.error(`sigil-rooms-web: ${error.message}`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`Open ${origin}`);
  console.log(`Start the relay with: sigil relay up --port ${new URL(relayUrl).port} --browser-origin ${origin} --room-human-identity <identity.json>`);
  console.log('Open exactly that origin: localhost and 127.0.0.1 are different origins to the relay.');
});
