import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIdentity } from './identity.mjs';
import { addEndpointToRegistry, saveRegistryFile } from './registry-store.mjs';
import { createBearerAuthenticator, hashBearerToken } from '../relay/v1/transport-auth.mjs';
import { DEFAULT_MAX_STALE_MS, startRegistryRefresh } from './registry-refresh.mjs';

const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });

function createFakeClock(initialMs = 1_000_000) {
  let currentMs = initialMs;
  let nextId = 1;
  let nextSeq = 1;
  const tasks = new Map();

  const resolveId = (handle) => (handle && typeof handle === 'object' ? handle.id : handle);

  const schedule = (fn, delayMs, intervalMs) => {
    const id = nextId++;
    const step = Math.max(0, Number(delayMs) || 0);
    const entry = {
      id,
      seq: nextSeq++,
      dueAt: currentMs + step,
      intervalMs,
      fn,
    };
    tasks.set(id, entry);
    return { id, unref() { return this; } };
  };

  return {
    now: () => currentMs,
    pending: () => tasks.size,
    setTimeout: (fn, ms) => schedule(fn, ms, null),
    clearTimeout: (handle) => { tasks.delete(resolveId(handle)); },
    setInterval: (fn, ms) => schedule(fn, ms, Math.max(1, Number(ms) || 1)),
    clearInterval: (handle) => { tasks.delete(resolveId(handle)); },
    async advance(ms) {
      const target = currentMs + ms;
      while (true) {
        let earliest = null;
        for (const entry of tasks.values()) {
          if (entry.dueAt <= target) {
            if (!earliest || entry.dueAt < earliest.dueAt || (entry.dueAt === earliest.dueAt && entry.seq < earliest.seq)) {
              earliest = entry;
            }
          }
        }
        if (!earliest) break;
        currentMs = earliest.dueAt;
        if (earliest.intervalMs !== null) {
          earliest.dueAt = currentMs + earliest.intervalMs;
          earliest.seq = nextSeq++;
        } else {
          tasks.delete(earliest.id);
        }
        await earliest.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      currentMs = target;
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function createFakeWatch() {
  let onEvent = null;
  const watcher = {
    dir: null,
    closed: false,
    watch(dir, callback) {
      watcher.dir = dir;
      onEvent = callback;
      return {
        close() {
          watcher.closed = true;
        },
      };
    },
    emit(eventType, filename) {
      if (!watcher.closed && onEvent) {
        onEvent(eventType, filename);
      }
    },
  };
  return watcher;
}

function makeTempRegistry(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-reg-refresh-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  return {
    tmpDir,
    registryPath: path.join(tmpDir, 'registry.json'),
  };
}

function fixtureBot(name) {
  return createIdentity({
    ownerId: 'usr_fixture@fixture.example',
    endpointId: `ep_fixture_${name}@fixture.example`,
    kind: 'agent',
  });
}

function createCaptureLogger() {
  const warnings = [];
  const infos = [];
  const errors = [];
  return {
    warnings,
    infos,
    errors,
    logger: {
      debug: () => {},
      info: (entry) => infos.push(entry),
      warn: (entry) => warnings.push(entry),
      error: (entry) => errors.push(entry),
    },
  };
}

test('initial load populates maps and reports ready generation 1', async (t) => {
  const { tmpDir, registryPath } = makeTempRegistry(t);
  const botA = fixtureBot('a');
  addEndpointToRegistry(registryPath, botA);

  const registry = new Map();
  const tokenHashes = new Map();
  const clock = createFakeClock();
  const fakeWatcher = createFakeWatch();

  const refresher = startRegistryRefresh({
    registryPath,
    registry,
    tokenHashes,
    watch: fakeWatcher.watch,
    clock,
    logger: createCaptureLogger().logger,
  });
  t.after(() => refresher.close());

  assert.equal(fakeWatcher.dir, tmpDir);
  assert.equal(registry.size, 0);
  assert.equal(tokenHashes.size, 0);

  const first = await refresher.refreshNow();
  assert.deepEqual(first, { ok: true, changed: true });
  assert.deepEqual(refresher.status(), { state: 'ready', generation: 1 });
  assert.equal(refresher.isAvailable(), true);
  assert.equal(registry.get(botA.endpoint_id)?.owner_id, botA.owner_id);
  assert.equal(tokenHashes.get(hashBearerToken(botA.relay_token)), botA.endpoint_id);

  const unchanged = await refresher.refreshNow();
  assert.deepEqual(unchanged, { ok: true, changed: false });
  assert.deepEqual(refresher.status(), { state: 'ready', generation: 1 });
});

test('new valid generation authenticates new bot without restart', async (t) => {
  const { registryPath } = makeTempRegistry(t);
  const botA = fixtureBot('a');
  const botB = fixtureBot('b');
  addEndpointToRegistry(registryPath, botA);

  const registry = new Map();
  const tokenHashes = new Map();
  const clock = createFakeClock();
  const fakeWatcher = createFakeWatch();

  const refresher = startRegistryRefresh({
    registryPath,
    registry,
    tokenHashes,
    watch: fakeWatcher.watch,
    clock,
    logger: createCaptureLogger().logger,
  });
  t.after(() => refresher.close());

  await refresher.refreshNow();
  const authenticate = createBearerAuthenticator(tokenHashes, registry);

  assert.deepEqual(await authenticate(bearer(botA.relay_token)), {
    endpoint_id: botA.endpoint_id,
    owner_id: botA.owner_id,
  });
  assert.equal(await authenticate(bearer(botB.relay_token)), null);

  addEndpointToRegistry(registryPath, botB);
  const second = await refresher.refreshNow();
  assert.deepEqual(second, { ok: true, changed: true });
  assert.deepEqual(refresher.status(), { state: 'ready', generation: 2 });

  assert.deepEqual(await authenticate(bearer(botB.relay_token)), {
    endpoint_id: botB.endpoint_id,
    owner_id: botB.owner_id,
  });
});

test('removed token is rejected and invalidation reports it', async (t) => {
  const { registryPath } = makeTempRegistry(t);
  const botA = fixtureBot('a');
  const botB = fixtureBot('b');
  addEndpointToRegistry(registryPath, botA);
  addEndpointToRegistry(registryPath, botB);

  const registry = new Map();
  const tokenHashes = new Map();
  const invalidated = [];
  const clock = createFakeClock();
  const fakeWatcher = createFakeWatch();

  const refresher = startRegistryRefresh({
    registryPath,
    registry,
    tokenHashes,
    watch: fakeWatcher.watch,
    clock,
    onInvalidate: (ids) => invalidated.push(ids),
    logger: createCaptureLogger().logger,
  });
  t.after(() => refresher.close());

  await refresher.refreshNow();
  const authenticate = createBearerAuthenticator(tokenHashes, registry);
  assert.equal((await authenticate(bearer(botB.relay_token)))?.endpoint_id, botB.endpoint_id);

  saveRegistryFile(registryPath, {
    endpoints: [{
      owner_id: botA.owner_id,
      endpoint_id: botA.endpoint_id,
      key_id: botA.key_id,
      kind: botA.kind,
      status: 'active',
      public_key_pem: botA.public_key_pem,
      relay_token: botA.relay_token,
    }],
  });

  const res = await refresher.refreshNow();
  assert.deepEqual(res, { ok: true, changed: true });
  assert.equal(await authenticate(bearer(botB.relay_token)), null);
  assert.equal((await authenticate(bearer(botA.relay_token)))?.endpoint_id, botA.endpoint_id);
  assert.deepEqual(invalidated, [[botB.endpoint_id]]);
});

test('rotated token invalidates the old token and reports the endpoint', async (t) => {
  const { registryPath } = makeTempRegistry(t);
  const botA = fixtureBot('a');
  const rotatedSource = fixtureBot('a_rotated');
  addEndpointToRegistry(registryPath, botA);

  const registry = new Map();
  const tokenHashes = new Map();
  const invalidated = [];
  const clock = createFakeClock();
  const fakeWatcher = createFakeWatch();

  const refresher = startRegistryRefresh({
    registryPath,
    registry,
    tokenHashes,
    watch: fakeWatcher.watch,
    clock,
    onInvalidate: (ids) => invalidated.push(ids),
    logger: createCaptureLogger().logger,
  });
  t.after(() => refresher.close());

  await refresher.refreshNow();
  const authenticate = createBearerAuthenticator(tokenHashes, registry);
  const oldToken = botA.relay_token;
  const newToken = rotatedSource.relay_token;

  addEndpointToRegistry(registryPath, { ...botA, relay_token: newToken });
  const res = await refresher.refreshNow();
  assert.deepEqual(res, { ok: true, changed: true });
  assert.equal(await authenticate(bearer(oldToken)), null);
  assert.deepEqual(await authenticate(bearer(newToken)), {
    endpoint_id: botA.endpoint_id,
    owner_id: botA.owner_id,
  });
  assert.deepEqual(invalidated, [[botA.endpoint_id]]);
});

test('watch events are debounced into one refresh', async (t) => {
  const { registryPath } = makeTempRegistry(t);
  const botA = fixtureBot('a');
  const botB = fixtureBot('b');
  addEndpointToRegistry(registryPath, botA);

  let readCount = 0;
  const registry = new Map();
  const tokenHashes = new Map();
  const clock = createFakeClock();
  const fakeWatcher = createFakeWatch();

  const refresher = startRegistryRefresh({
    registryPath,
    registry,
    tokenHashes,
    readFile: async (p) => {
      readCount += 1;
      return fs.promises.readFile(p, 'utf8');
    },
    watch: fakeWatcher.watch,
    clock,
    debounceMs: 200,
    pollMs: 1000,
    logger: createCaptureLogger().logger,
  });
  t.after(() => refresher.close());

  await refresher.refreshNow();
  assert.equal(readCount, 1);

  addEndpointToRegistry(registryPath, botB);
  const base = path.basename(registryPath);
  fakeWatcher.emit('change', base);
  await clock.advance(50);
  fakeWatcher.emit('rename', base);
  await clock.advance(50);
  fakeWatcher.emit('change', null);
  assert.equal(readCount, 1);

  await clock.advance(200);
  await refresher.whenIdle();

  assert.equal(readCount, 2);
  assert.equal(refresher.status().generation, 2);
  assert.equal(registry.has(botB.endpoint_id), true);
});

test('watch events for other files are ignored', async (t) => {
  const { registryPath } = makeTempRegistry(t);
  const botA = fixtureBot('a');
  addEndpointToRegistry(registryPath, botA);

  let readCount = 0;
  const registry = new Map();
  const tokenHashes = new Map();
  const clock = createFakeClock();
  const fakeWatcher = createFakeWatch();

  const refresher = startRegistryRefresh({
    registryPath,
    registry,
    tokenHashes,
    readFile: async (p) => {
      readCount += 1;
      return fs.promises.readFile(p, 'utf8');
    },
    watch: fakeWatcher.watch,
    clock,
    debounceMs: 200,
    pollMs: 1000,
    logger: createCaptureLogger().logger,
  });
  t.after(() => refresher.close());

  await refresher.refreshNow();
  assert.equal(readCount, 1);

  fakeWatcher.emit('change', 'other.json');
  fakeWatcher.emit('rename', 'registry.json.tmp');
  fakeWatcher.emit('change', 'unrelated.txt');

  await clock.advance(300);
  await refresher.whenIdle();
  assert.equal(readCount, 1);
});

test('poll recovers a missed watch event within pollMs', async (t) => {
  const { registryPath } = makeTempRegistry(t);
  const botA = fixtureBot('a');
  const botB = fixtureBot('b');
  addEndpointToRegistry(registryPath, botA);

  const registry = new Map();
  const tokenHashes = new Map();
  const clock = createFakeClock();
  const fakeWatcher = createFakeWatch();

  const refresher = startRegistryRefresh({
    registryPath,
    registry,
    tokenHashes,
    watch: fakeWatcher.watch,
    clock,
    debounceMs: 200,
    pollMs: 1000,
    logger: createCaptureLogger().logger,
  });
  t.after(() => refresher.close());

  await refresher.refreshNow();
  assert.equal(registry.has(botB.endpoint_id), false);

  addEndpointToRegistry(registryPath, botB);
  await clock.advance(1000);
  await refresher.whenIdle();

  assert.equal(registry.has(botB.endpoint_id), true);
  assert.deepEqual(refresher.status(), { state: 'ready', generation: 2 });
});

test('invalid json keeps last good maps and logs without secrets', async (t) => {
  const { registryPath } = makeTempRegistry(t);
  const botA = fixtureBot('a');
  addEndpointToRegistry(registryPath, botA);

  const registry = new Map();
  const tokenHashes = new Map();
  const clock = createFakeClock();
  const fakeWatcher = createFakeWatch();
  const captured = createCaptureLogger();

  const refresher = startRegistryRefresh({
    registryPath,
    registry,
    tokenHashes,
    watch: fakeWatcher.watch,
    clock,
    logger: captured.logger,
  });
  t.after(() => refresher.close());

  await refresher.refreshNow();

  const badText = `{corrupt json payload ${botA.relay_token} CORRUPT_MARKER_TEXT`;
  fs.writeFileSync(registryPath, badText, 'utf8');

  const res = await refresher.refreshNow();
  assert.deepEqual(res, { ok: false, code: 'REGISTRY_INVALID_JSON' });
  assert.equal(registry.has(botA.endpoint_id), true);
  assert.equal(tokenHashes.get(hashBearerToken(botA.relay_token)), botA.endpoint_id);
  assert.deepEqual(refresher.status(), { state: 'stale', generation: 1 });

  assert.equal(captured.warnings.length, 1);
  assert.deepEqual(captured.warnings[0], {
    event: 'registry.refresh_failed',
    code: 'REGISTRY_INVALID_JSON',
  });
  const joinedLogs = JSON.stringify([captured.warnings, captured.infos, captured.errors]);
  assert.equal(joinedLogs.includes(botA.relay_token), false);
  assert.equal(joinedLogs.includes('CORRUPT_MARKER_TEXT'), false);
  assert.equal(joinedLogs.includes(badText), false);
});

test('invalid entry or duplicate is rejected without partial swap', async (t) => {
  const { registryPath } = makeTempRegistry(t);
  const botA = fixtureBot('a');
  const botB = fixtureBot('b');
  const botC = fixtureBot('c');
  addEndpointToRegistry(registryPath, botA);

  const registry = new Map();
  const tokenHashes = new Map();
  const clock = createFakeClock();
  const fakeWatcher = createFakeWatch();

  const refresher = startRegistryRefresh({
    registryPath,
    registry,
    tokenHashes,
    watch: fakeWatcher.watch,
    clock,
    logger: createCaptureLogger().logger,
  });
  t.after(() => refresher.close());

  await refresher.refreshNow();
  const authenticate = createBearerAuthenticator(tokenHashes, registry);

  saveRegistryFile(registryPath, {
    endpoints: [
      {
        owner_id: botB.owner_id,
        endpoint_id: botB.endpoint_id,
        key_id: botB.key_id,
        kind: botB.kind,
        status: 'active',
        public_key_pem: botB.public_key_pem,
        relay_token: botB.relay_token,
      },
      {
        owner_id: botC.owner_id,
        endpoint_id: botC.endpoint_id,
        key_id: botC.key_id,
        kind: botC.kind,
        status: 'active',
        public_key_pem: 'not-a-valid-public-key-pem',
        relay_token: botC.relay_token,
      },
    ],
  });

  const invalidRes = await refresher.refreshNow();
  assert.deepEqual(invalidRes, { ok: false, code: 'REGISTRY_INVALID_ENTRY' });
  assert.deepEqual([...registry.keys()], [botA.endpoint_id]);
  assert.deepEqual([...tokenHashes.values()], [botA.endpoint_id]);
  assert.equal(await authenticate(bearer(botB.relay_token)), null);

  saveRegistryFile(registryPath, {
    endpoints: [
      {
        owner_id: botB.owner_id,
        endpoint_id: botB.endpoint_id,
        key_id: botB.key_id,
        kind: botB.kind,
        status: 'active',
        public_key_pem: botB.public_key_pem,
        relay_token: botB.relay_token,
      },
      {
        owner_id: botC.owner_id,
        endpoint_id: botB.endpoint_id,
        key_id: botC.key_id,
        kind: botC.kind,
        status: 'active',
        public_key_pem: botC.public_key_pem,
        relay_token: botC.relay_token,
      },
    ],
  });

  const dupRes = await refresher.refreshNow();
  assert.deepEqual(dupRes, { ok: false, code: 'REGISTRY_DUPLICATE' });
  assert.deepEqual([...registry.keys()], [botA.endpoint_id]);
  assert.deepEqual([...tokenHashes.values()], [botA.endpoint_id]);
  assert.equal(await authenticate(bearer(botB.relay_token)), null);
});

test('unprotected registry is rejected', async (t) => {
  const { registryPath } = makeTempRegistry(t);
  const botA = fixtureBot('a');
  const botB = fixtureBot('b');
  addEndpointToRegistry(registryPath, botA);

  let protectionOk = true;
  const registry = new Map();
  const tokenHashes = new Map();
  const clock = createFakeClock();
  const fakeWatcher = createFakeWatch();
  const captured = createCaptureLogger();

  const refresher = startRegistryRefresh({
    registryPath,
    registry,
    tokenHashes,
    validateProtection: async () => protectionOk,
    watch: fakeWatcher.watch,
    clock,
    logger: captured.logger,
  });
  t.after(() => refresher.close());

  await refresher.refreshNow();

  protectionOk = false;
  addEndpointToRegistry(registryPath, botB);
  const res = await refresher.refreshNow();
  assert.deepEqual(res, { ok: false, code: 'REGISTRY_UNPROTECTED' });
  assert.deepEqual([...registry.keys()], [botA.endpoint_id]);
  assert.equal(registry.has(botB.endpoint_id), false);
});

test('bounded staleness makes auth unavailable then recovers', async (t) => {
  const { registryPath } = makeTempRegistry(t);
  const botA = fixtureBot('a');
  addEndpointToRegistry(registryPath, botA);

  const registry = new Map();
  const tokenHashes = new Map();
  const clock = createFakeClock();
  const fakeWatcher = createFakeWatch();

  const refresher = startRegistryRefresh({
    registryPath,
    registry,
    tokenHashes,
    watch: fakeWatcher.watch,
    clock,
    maxStaleMs: 5000,
    pollMs: 100_000,
    logger: createCaptureLogger().logger,
  });
  t.after(() => refresher.close());

  await refresher.refreshNow();
  const authenticate = createBearerAuthenticator(tokenHashes, registry, {
    isAvailable: () => refresher.isAvailable(),
  });

  fs.rmSync(registryPath, { force: true });
  const failRes = await refresher.refreshNow();
  assert.deepEqual(failRes, { ok: false, code: 'REGISTRY_MISSING' });
  assert.equal(refresher.isAvailable(), true);
  assert.equal(refresher.status().state, 'stale');
  assert.equal((await authenticate(bearer(botA.relay_token)))?.endpoint_id, botA.endpoint_id);

  await clock.advance(5000);
  assert.equal(refresher.isAvailable(), true);
  assert.equal(refresher.status().state, 'stale');

  await clock.advance(1);
  assert.equal(refresher.isAvailable(), false);
  assert.equal(refresher.status().state, 'unavailable');
  assert.equal(await authenticate(bearer(botA.relay_token)), null);

  addEndpointToRegistry(registryPath, botA);
  const recoverRes = await refresher.refreshNow();
  assert.equal(recoverRes.ok, true);
  assert.equal(refresher.isAvailable(), true);
  assert.equal(refresher.status().state, 'ready');
  assert.equal((await authenticate(bearer(botA.relay_token)))?.endpoint_id, botA.endpoint_id);
});

test('swap is atomic within one synchronous block', async (t) => {
  const { registryPath } = makeTempRegistry(t);
  const botA = fixtureBot('a');
  const botB = fixtureBot('b');
  addEndpointToRegistry(registryPath, botA);

  const snapshots = [];
  const tokenHashes = new Map();
  class ObservingMap extends Map {
    clear() {
      super.clear();
      queueMicrotask(() => {
        snapshots.push({
          keys: [...this.keys()],
          hashEndpoints: [...tokenHashes.values()],
        });
      });
    }
  }
  const registry = new ObservingMap();
  const clock = createFakeClock();
  const fakeWatcher = createFakeWatch();

  const refresher = startRegistryRefresh({
    registryPath,
    registry,
    tokenHashes,
    watch: fakeWatcher.watch,
    clock,
    logger: createCaptureLogger().logger,
  });
  t.after(() => refresher.close());

  await refresher.refreshNow();
  addEndpointToRegistry(registryPath, botB);
  await refresher.refreshNow();

  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[0], {
    keys: [botA.endpoint_id],
    hashEndpoints: [botA.endpoint_id],
  });
  assert.deepEqual(snapshots[1], {
    keys: [botA.endpoint_id, botB.endpoint_id],
    hashEndpoints: [botA.endpoint_id, botB.endpoint_id],
  });
});

test('same Map objects are mutated in place', async (t) => {
  const { registryPath } = makeTempRegistry(t);
  const botA = fixtureBot('a');
  const botB = fixtureBot('b');
  addEndpointToRegistry(registryPath, botA);

  const registry = new Map();
  const tokenHashes = new Map();
  const origRegistry = registry;
  const origTokenHashes = tokenHashes;
  const clock = createFakeClock();
  const fakeWatcher = createFakeWatch();

  const refresher = startRegistryRefresh({
    registryPath,
    registry,
    tokenHashes,
    watch: fakeWatcher.watch,
    clock,
    logger: createCaptureLogger().logger,
  });
  t.after(() => refresher.close());

  await refresher.refreshNow();
  addEndpointToRegistry(registryPath, botB);
  await refresher.refreshNow();

  assert.equal(registry, origRegistry);
  assert.equal(tokenHashes, origTokenHashes);
  assert.deepEqual([...origRegistry.keys()], [botA.endpoint_id, botB.endpoint_id]);
  assert.deepEqual([...origTokenHashes.values()], [botA.endpoint_id, botB.endpoint_id]);
});

test('close stops watcher and timers', async (t) => {
  const { registryPath } = makeTempRegistry(t);
  const botA = fixtureBot('a');
  const botB = fixtureBot('b');
  addEndpointToRegistry(registryPath, botA);

  let readCount = 0;
  const registry = new Map();
  const tokenHashes = new Map();
  const clock = createFakeClock();
  const fakeWatcher = createFakeWatch();

  const refresher = startRegistryRefresh({
    registryPath,
    registry,
    tokenHashes,
    readFile: async (p) => {
      readCount += 1;
      return fs.promises.readFile(p, 'utf8');
    },
    watch: fakeWatcher.watch,
    clock,
    debounceMs: 200,
    pollMs: 1000,
    logger: createCaptureLogger().logger,
  });

  await refresher.refreshNow();
  assert.equal(readCount, 1);

  refresher.close();
  assert.equal(fakeWatcher.closed, true);
  assert.equal(clock.pending(), 0);

  addEndpointToRegistry(registryPath, botB);
  fakeWatcher.emit('change', path.basename(registryPath));
  await clock.advance(5000);
  await refresher.whenIdle();

  assert.equal(readCount, 1);
  assert.equal(registry.has(botB.endpoint_id), false);
});

test('bot add no longer tells operators to restart the relay', () => {
  const source = fs.readFileSync(new URL('./bot-commands.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /restart relay/i);
  assert.equal(source.includes('no restart needed'), true);
});

test('entry missing a required field is rejected without swap', async (t) => {
  const { registryPath } = makeTempRegistry(t);
  const botA = fixtureBot('a');
  const botB = fixtureBot('b');
  addEndpointToRegistry(registryPath, botA);

  const registry = new Map();
  const tokenHashes = new Map();
  const refresher = startRegistryRefresh({
    registryPath,
    registry,
    tokenHashes,
    watch: createFakeWatch().watch,
    clock: createFakeClock(),
    logger: createCaptureLogger().logger,
  });
  t.after(() => refresher.close());
  await refresher.refreshNow();

  const full = {
    owner_id: botB.owner_id,
    endpoint_id: botB.endpoint_id,
    key_id: botB.key_id,
    kind: botB.kind,
    status: 'active',
    public_key_pem: botB.public_key_pem,
    relay_token: botB.relay_token,
  };
  for (const field of ['endpoint_id', 'owner_id', 'key_id', 'kind', 'relay_token', 'public_key_pem']) {
    const entry = { ...full };
    delete entry[field];
    saveRegistryFile(registryPath, { endpoints: [entry] });
    const res = await refresher.refreshNow();
    assert.deepEqual(res, { ok: false, code: 'REGISTRY_INVALID_ENTRY' }, field);
    assert.deepEqual([...registry.keys()], [botA.endpoint_id], field);
    assert.deepEqual([...tokenHashes.values()], [botA.endpoint_id], field);
  }
});

test('default grace period is 30 seconds', async (t) => {
  assert.equal(DEFAULT_MAX_STALE_MS, 30000);

  const { registryPath } = makeTempRegistry(t);
  const botA = fixtureBot('a');
  addEndpointToRegistry(registryPath, botA);

  const registry = new Map();
  const tokenHashes = new Map();
  const clock = createFakeClock();
  const fakeWatcher = createFakeWatch();

  const refresher = startRegistryRefresh({
    registryPath,
    registry,
    tokenHashes,
    watch: fakeWatcher.watch,
    clock,
    pollMs: 1_000_000,
    logger: createCaptureLogger().logger,
  });
  t.after(() => refresher.close());

  await refresher.refreshNow();

  fs.rmSync(registryPath, { force: true });
  const failRes = await refresher.refreshNow();
  assert.deepEqual(failRes, { ok: false, code: 'REGISTRY_MISSING' });
  assert.equal(refresher.isAvailable(), true);
  assert.equal(refresher.status().state, 'stale');

  await clock.advance(29_999);
  assert.equal(refresher.isAvailable(), true);
  assert.equal(refresher.status().state, 'stale');

  await clock.advance(1);
  assert.equal(refresher.isAvailable(), true);
  assert.equal(refresher.status().state, 'stale');

  await clock.advance(1);
  assert.equal(refresher.isAvailable(), false);
  assert.equal(refresher.status().state, 'unavailable');
});
