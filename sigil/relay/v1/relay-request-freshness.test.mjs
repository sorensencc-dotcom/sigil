import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RELAY_REQUEST_FRESHNESS_MS, resolveRelayRequestFreshnessMs } from './relay-config.mjs';
import { createRelayServer } from './http-server.mjs';

test('default when unset or invalid', () => {
  assert.equal(DEFAULT_RELAY_REQUEST_FRESHNESS_MS, 300_000);
  assert.equal(resolveRelayRequestFreshnessMs(undefined), 300_000);
  assert.equal(resolveRelayRequestFreshnessMs(null), 300_000);
  assert.equal(resolveRelayRequestFreshnessMs('nope'), 300_000);
  assert.equal(resolveRelayRequestFreshnessMs(Number.NaN), 300_000);
});

test('clamps to [60_000, 3_600_000]', () => {
  assert.equal(resolveRelayRequestFreshnessMs(1_000), 60_000);
  assert.equal(resolveRelayRequestFreshnessMs(10_000_000), 3_600_000);
  assert.equal(resolveRelayRequestFreshnessMs(120_000), 120_000);
});

// The startup announcement is deduped per WINDOW VALUE, not per process: two
// federated relays in one process with different windows must both announce
// theirs, or the second relay's configuration never appears in the log.
test('each distinct freshness window is announced once, per relay not per process', (t) => {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  t.after(() => { console.error = original; });

  const windows = [];
  const build = (relayRequestFreshnessMs) => {
    const server = createRelayServer({ registry: new Map(), federationMode: 'sync', relayDomain: 'a.example', relayRequestFreshnessMs });
    t.after(() => server.close());
    return server;
  };
  // Two relays, two windows -> two lines. A repeat of a window already
  // announced adds nothing.
  build(120_000);
  build(600_000);
  build(120_000);
  for (const line of lines) {
    const m = line.match(/relay request freshness window = (\d+) ms/);
    if (m) windows.push(Number(m[1]));
  }
  assert.deepEqual(windows, [120_000, 600_000]);

  // A non-federated relay never applies the window and never announces one.
  const before = lines.length;
  const plain = createRelayServer({ registry: new Map(), relayRequestFreshnessMs: 900_000 });
  t.after(() => plain.close());
  assert.equal(lines.length, before);
});
