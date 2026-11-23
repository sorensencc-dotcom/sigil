// Connector-only health probe: node sigil/cli/connector-health.mjs --service-config <path>
// Probes each connector's /mcp/memory on 127.0.0.1. If one is down, runs
// `sigil service start --service-config <path>`, which starts only the
// components in that file. Refuses any config that is not connector-only,
// so it can never touch the room stack.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadServiceConfigFile, validateServiceConfig } from './service-config.mjs';
import { cmdService } from './service-command.mjs';

export function isConnectorOnlyConfig(config) {
  return Array.isArray(config?.connectors) && config.connectors.length > 0
    && config.relay === undefined && config.rooms_web === undefined && config.agents === undefined;
}

export async function probeMemoryEndpoint(port, { fetchImpl = globalThis.fetch, timeoutMs = 3000 } = {}) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/mcp/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    return res.ok && Boolean(body?.result?.serverInfo);
  } catch {
    return false;
  }
}

export async function ensureConnector({
  configPath,
  loadConfig = loadServiceConfigFile,
  probe = probeMemoryEndpoint,
  start = (p) => cmdService(['start', '--service-config', p]),
  retries = 10,
  delayMs = 500,
} = {}) {
  const config = loadConfig(configPath);
  const validation = validateServiceConfig(config);
  if (!validation.ok) {
    throw new Error(`invalid service config ${configPath}: ${validation.issues.map((i) => i.message).join('; ')}`);
  }
  if (!isConnectorOnlyConfig(config)) {
    throw new Error(`refusing ${configPath}: not connector-only (relay, rooms_web or agents present, or no connectors)`);
  }
  const ports = config.connectors.map((c) => c.port);
  const down = async () => {
    const states = await Promise.all(ports.map((p) => probe(p)));
    return ports.filter((_, i) => !states[i]);
  };

  if ((await down()).length === 0) return { status: 'up', ports };
  await start(configPath);
  for (let i = 0; i < retries; i += 1) {
    if ((await down()).length === 0) return { status: 'started', ports };
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`connector still down after start on port(s) ${(await down()).join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'service-config': { type: 'string' } } });
  if (!values['service-config']) {
    console.error('usage: node sigil/cli/connector-health.mjs --service-config <connector-only config>');
    process.exit(2);
  }
  ensureConnector({ configPath: values['service-config'] }).then(
    (r) => console.log(`connector ${r.status} on port(s) ${r.ports.join(', ')}`),
    (err) => { console.error(`connector-health: ${err.message}`); process.exit(1); },
  );
}
