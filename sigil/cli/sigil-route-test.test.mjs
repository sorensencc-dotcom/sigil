import test from 'node:test';
import assert from 'node:assert/strict';
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
    ['route', 'test', 'not-a-valid-id', '--identity', '.sigil/alice.identity.json', '--relay-url', 'http://127.0.0.1:1'],
    dir,
  );
  assert.equal(res.exitCode, 1);
  assert.doesNotMatch(res.stdout, /Recipient:/);
});

test('route test: an unpinned domain reports "Pinned: no" and stops non-zero', async (t) => {
  const dir = await makeWorkdir(t);
  const stub = await startStubRelay(t);
  const res = await run(
    ['route', 'test', 'ep_bob@b.example', '--identity', '.sigil/alice.identity.json', '--relay-url', stub.url],
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
        '--relay-url', stub.url,
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
