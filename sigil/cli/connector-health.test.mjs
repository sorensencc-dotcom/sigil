import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureConnector, isConnectorOnlyConfig } from './connector-health.mjs';

const connectorOnly = {
  version: 1,
  connectors: [{ name: 'kb-sync', provider: 'kb-sync', port: 4411, identity: 'id.json' }],
};

test('isConnectorOnlyConfig rejects relay, rooms_web, agents and empty connectors', () => {
  assert.equal(isConnectorOnlyConfig(connectorOnly), true);
  assert.equal(isConnectorOnlyConfig({ ...connectorOnly, relay: { port: 8791 } }), false);
  assert.equal(isConnectorOnlyConfig({ ...connectorOnly, rooms_web: { port: 5173 } }), false);
  assert.equal(isConnectorOnlyConfig({ ...connectorOnly, agents: [] }), false);
  assert.equal(isConnectorOnlyConfig({ version: 1 }), false);
});

test('ensureConnector refuses a room stack config without probing or starting', async () => {
  let touched = false;
  const roomStack = { relay: { port: 8791 }, connectors: connectorOnly.connectors };
  await assert.rejects(
    ensureConnector({
      configPath: 'service.json',
      loadConfig: () => roomStack,
      probe: async () => { touched = true; return false; },
      start: async () => { touched = true; },
    }),
    /not connector-only/,
  );
  assert.equal(touched, false);
});

test('ensureConnector does nothing when the connector is up', async () => {
  const started = [];
  const r = await ensureConnector({
    configPath: 'kb.json',
    loadConfig: () => connectorOnly,
    probe: async () => true,
    start: async (p) => started.push(p),
  });
  assert.deepEqual(r, { status: 'up', ports: [4411] });
  assert.deepEqual(started, []);
});

test('ensureConnector starts only the given connector config when the port is down', async () => {
  const started = [];
  let up = false;
  const r = await ensureConnector({
    configPath: 'kb.json',
    loadConfig: (p) => { assert.equal(p, 'kb.json'); return connectorOnly; },
    probe: async () => up,
    start: async (p) => { started.push(p); up = true; },
    delayMs: 1,
  });
  assert.deepEqual(r, { status: 'started', ports: [4411] });
  assert.deepEqual(started, ['kb.json']);
});

test('ensureConnector fails when the connector stays down after start', async () => {
  await assert.rejects(
    ensureConnector({
      configPath: 'kb.json',
      loadConfig: () => connectorOnly,
      probe: async () => false,
      start: async () => {},
      retries: 2,
      delayMs: 1,
    }),
    /still down/,
  );
});
