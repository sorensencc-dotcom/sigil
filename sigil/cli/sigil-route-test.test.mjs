import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const sigilPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');
const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

// Every run gets an isolated cwd so `.sigil/` (identity + registry) never
// leaks between tests or into the repo. SIGIL_DATABASE_URL is forced empty so
// only an explicit --database-url reaches the peer directory.
async function run(args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [sigilPath, ...args], {
      cwd,
      env: { ...process.env, SIGIL_DATABASE_URL: '' },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code };
  }
}

async function makeWorkdir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sigil-route-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const init = await run(['init', 'alice', '--domain', 'local'], dir);
  assert.equal(init.exitCode, 0, init.stderr);
  return dir;
}

// A throwaway relay that answers GET /v1/health and records every request it
// sees, so the test can prove `route test` GETs health and POSTs nothing.
async function startStubRelay(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

test('route test: a malformed recipient federated id exits non-zero', async (t) => {
  const dir = await makeWorkdir(t);
  const res = await run(
    ['route', 'test', 'not-a-valid-id', '--identity', '.sigil/alice.identity.json'],
    dir,
  );
  assert.equal(res.exitCode, 1);
  assert.doesNotMatch(res.stdout, /Recipient:/);
});

test('route test: an unpinned domain reports "Pinned: no" and stops non-zero', async (t) => {
  const dir = await makeWorkdir(t);
  const stub = await startStubRelay(t);
  const res = await run(
    ['route', 'test', 'ep_bob@b.example', '--identity', '.sigil/alice.identity.json'],
    dir,
  );
  assert.match(res.stdout, /Recipient: ep_bob@b\.example/);
  assert.match(res.stdout, /Pinned: no/);
  assert.doesNotMatch(res.stdout, /Reachable:/);
  assert.equal(res.exitCode, 1);
  // Nothing was ever sent to the relay.
  assert.deepEqual(stub.seen, []);
});

test(
  'route test: a pinned peer reports its relay URL, reachability, and the advisory line (GET /v1/health only)',
  { skip: !connectionString },
  async (t) => {
    const { default: pg } = await import('pg');
    const { assertDisposableTestDatabase } = await import('../scripts/assert-disposable-test-db.mjs');
    assertDisposableTestDatabase(connectionString);
    const pool = new pg.Pool({ connectionString });
    t.after(() => pool.end());
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');

    const dir = await makeWorkdir(t);
    const stub = await startStubRelay(t);

    const add = await run(
      [
        'peer', 'add', 'b.example',
        '--relay-url', stub.url,
        '--public-key', 'AAAAC3NzaC1lZDI1NTE5AAAAITESTKEY',
        '--kid', 'key_route_test',
        '--database-url', connectionString,
      ],
      dir,
    );
    assert.equal(add.exitCode, 0, add.stderr);

    const res = await run(
      [
        'route', 'test', 'ep_bob@b.example',
        '--identity', '.sigil/alice.identity.json',
        '--database-url', connectionString,
      ],
      dir,
    );
    assert.equal(res.exitCode, 0, res.stderr);
    assert.match(res.stdout, /Recipient: ep_bob@b\.example/);
    assert.match(res.stdout, /Pinned: yes/);
    assert.match(res.stdout, new RegExp(`Peer relay URL: ${stub.url.replace(/[.]/g, '\\.')}`));
    assert.match(res.stdout, /Reachable: yes \(\d+ms\)/);
    assert.match(res.stdout, /Same-owner exemption: not determinable locally/);
    assert.match(res.stdout, /\(advisory only — the receiving relay re-checks against its own registry\)/);

    // The only thing `route test` ever asked the relay for is its health.
    assert.deepEqual(stub.seen, ['GET /v1/health']);
  },
);

// Append a recipient endpoint straight into the local registry JSON so the
// step-4 advisory line (only reached for a PINNED peer) has something to look
// up. `toRegistryMap` builds a public key from `public_key_pem`, so a real PEM
// is required even though the advisory never uses the key.
async function seedRegistryEndpoint(dir, { endpointId, ownerId }) {
  const registryPath = path.join(dir, '.sigil', 'registry.json');
  const data = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  data.endpoints.push({
    owner_id: ownerId,
    endpoint_id: endpointId,
    key_id: `key_${endpointId}`,
    kind: 'agent',
    status: 'active',
    public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }),
    relay_token: `tok_${endpointId}`,
  });
  await fs.writeFile(registryPath, JSON.stringify(data, null, 2));
}

async function pinPeer(dir, domain, relayUrl) {
  return run(
    [
      'peer', 'add', domain,
      '--relay-url', relayUrl,
      '--public-key', 'AAAAC3NzaC1lZDI1NTE5AAAAITESTKEY',
      '--kid', `key_${domain}`,
      '--database-url', connectionString,
    ],
    dir,
  );
}

test(
  'route test: a pinned but unreachable peer prints "Reachable: no" and exits non-zero',
  { skip: !connectionString },
  async (t) => {
    const { default: pg } = await import('pg');
    const { assertDisposableTestDatabase } = await import('../scripts/assert-disposable-test-db.mjs');
    assertDisposableTestDatabase(connectionString);
    const pool = new pg.Pool({ connectionString });
    t.after(() => pool.end());
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');

    const dir = await makeWorkdir(t);
    // 127.0.0.1:1 has nothing listening -> checkRelayConnectivity fails.
    const add = await pinPeer(dir, 'b.example', 'http://127.0.0.1:1');
    assert.equal(add.exitCode, 0, add.stderr);

    const res = await run(
      ['route', 'test', 'ep_bob@b.example', '--identity', '.sigil/alice.identity.json', '--database-url', connectionString],
      dir,
    );
    assert.match(res.stdout, /Pinned: yes/);
    assert.match(res.stdout, /Reachable: no/);
    assert.equal(res.exitCode, 1);
  },
);

test(
  'route test: advisory says "would apply" when the recipient owner equals the sender owner',
  { skip: !connectionString },
  async (t) => {
    const { default: pg } = await import('pg');
    const { assertDisposableTestDatabase } = await import('../scripts/assert-disposable-test-db.mjs');
    assertDisposableTestDatabase(connectionString);
    const pool = new pg.Pool({ connectionString });
    t.after(() => pool.end());
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');

    const dir = await makeWorkdir(t);
    const stub = await startStubRelay(t);
    const add = await pinPeer(dir, 'b.example', stub.url);
    assert.equal(add.exitCode, 0, add.stderr);
    // alice's owner id is usr_alice@local (init default). Same owner => exemption applies.
    await seedRegistryEndpoint(dir, { endpointId: 'ep_bob@b.example', ownerId: 'usr_alice@local' });

    const res = await run(
      ['route', 'test', 'ep_bob@b.example', '--identity', '.sigil/alice.identity.json', '--database-url', connectionString],
      dir,
    );
    assert.equal(res.exitCode, 0, res.stderr);
    assert.match(res.stdout, /Same-owner exemption: would apply \(advisory\)/);
  },
);

test(
  'route test: advisory says "would NOT apply" when the recipient owner differs',
  { skip: !connectionString },
  async (t) => {
    const { default: pg } = await import('pg');
    const { assertDisposableTestDatabase } = await import('../scripts/assert-disposable-test-db.mjs');
    assertDisposableTestDatabase(connectionString);
    const pool = new pg.Pool({ connectionString });
    t.after(() => pool.end());
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');

    const dir = await makeWorkdir(t);
    const stub = await startStubRelay(t);
    const add = await pinPeer(dir, 'b.example', stub.url);
    assert.equal(add.exitCode, 0, add.stderr);
    await seedRegistryEndpoint(dir, { endpointId: 'ep_bob@b.example', ownerId: 'usr_bob@b.example' });

    const res = await run(
      ['route', 'test', 'ep_bob@b.example', '--identity', '.sigil/alice.identity.json', '--database-url', connectionString],
      dir,
    );
    assert.equal(res.exitCode, 0, res.stderr);
    assert.match(res.stdout, /Same-owner exemption: would NOT apply \(advisory\) — owner ids differ/);
  },
);
