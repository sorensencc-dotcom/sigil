import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {
  findPostgresBin,
  startDisposablePostgres,
  main,
} from './live-db-local.mjs';

test('findPostgresBin prefers SIGIL_PG_BIN when it has all three binaries', () => {
  const validBin = '/custom/pg/bin';
  const files = new Set([
    path.posix.join(validBin, 'initdb'),
    path.posix.join(validBin, 'pg_ctl'),
    path.posix.join(validBin, 'postgres'),
    '/usr/bin/initdb',
    '/usr/bin/pg_ctl',
    '/usr/bin/postgres',
  ]);
  const result = findPostgresBin({
    env: { SIGIL_PG_BIN: validBin, PATH: '/usr/bin' },
    platform: 'linux',
    exists: (p) => files.has(p),
    listDir: () => [],
    repoRoot: '/repo',
  });
  assert.equal(result, validBin);
});

test('findPostgresBin skips a candidate missing postgres and falls back to PATH', () => {
  const incompleteBin = '/incomplete/pg/bin';
  const pathBin = '/usr/local/pgsql/bin';
  const files = new Set([
    path.posix.join(incompleteBin, 'initdb'),
    path.posix.join(incompleteBin, 'pg_ctl'),
    // missing postgres in incompleteBin
    path.posix.join(pathBin, 'initdb'),
    path.posix.join(pathBin, 'pg_ctl'),
    path.posix.join(pathBin, 'postgres'),
  ]);
  const result = findPostgresBin({
    env: { SIGIL_PG_BIN: incompleteBin, PATH: `/bin:${pathBin}:/usr/bin` },
    platform: 'linux',
    exists: (p) => files.has(p),
    listDir: () => [],
    repoRoot: '/repo',
  });
  assert.equal(result, pathBin);
});

test('findPostgresBin picks the highest /usr/lib/postgresql version on linux', () => {
  const pg16 = '/usr/lib/postgresql/16/bin';
  const pg14 = '/usr/lib/postgresql/14/bin';
  const files = new Set([
    path.posix.join(pg14, 'initdb'),
    path.posix.join(pg14, 'pg_ctl'),
    path.posix.join(pg14, 'postgres'),
    path.posix.join(pg16, 'initdb'),
    path.posix.join(pg16, 'pg_ctl'),
    path.posix.join(pg16, 'postgres'),
  ]);
  const result = findPostgresBin({
    env: { PATH: '/usr/bin' },
    platform: 'linux',
    exists: (p) => files.has(p),
    listDir: (d) => (d === '/usr/lib/postgresql' ? ['14', '16', 'common'] : []),
    repoRoot: '/repo',
  });
  assert.equal(result, pg16);
});

test('findPostgresBin uses .exe names and ; separators on win32', () => {
  const winBin = 'C:/PostgreSQL/16/bin';
  const files = new Set([
    `${winBin}/initdb.exe`,
    `${winBin}/pg_ctl.exe`,
    `${winBin}/postgres.exe`,
  ]);
  const result = findPostgresBin({
    env: { PATH: `C:/Windows/System32;${winBin};C:/Tools` },
    platform: 'win32',
    exists: (p) => files.has(p.replace(/\\/g, '/')),
    listDir: () => [],
    repoRoot: 'C:/repo',
  });
  assert.equal(result, winBin);
});

test('findPostgresBin returns null when nothing is installed', () => {
  const result = findPostgresBin({
    env: { PATH: '/usr/bin:/bin' },
    platform: 'linux',
    exists: () => false,
    listDir: () => {
      throw new Error('ENOENT');
    },
    repoRoot: '/repo',
  });
  assert.equal(result, null);
});

test('main returns 2 with guidance and starts nothing when no binaries are found', async () => {
  const logs = [];
  let startCalled = false;
  let runSuitesCalled = false;
  const code = await main([], {
    findPostgresBin: () => null,
    startDisposablePostgres: async () => {
      startCalled = true;
      throw new Error('should not start');
    },
    runSuites: async () => {
      runSuitesCalled = true;
      return 0;
    },
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 2);
  assert.equal(startCalled, false);
  assert.equal(runSuitesCalled, false);
  const combined = logs.join('\n');
  assert.match(combined, /SIGIL_PG_BIN/);
  assert.match(combined, /@embedded-postgres/);
});

test('main always stops the cluster and returns the suite exit code', async () => {
  // Case 1: runSuites resolves 1 -> main returns 1 and stop called once
  {
    let stopCount = 0;
    const code = await main(['some.test.mjs'], {
      findPostgresBin: () => '/pg/bin',
      startDisposablePostgres: async () => ({
        url: 'postgres://sigil@127.0.0.1:55432/sigil_test',
        port: 55432,
        dataDir: '/tmp/fake-data',
        stop: async () => {
          stopCount += 1;
        },
      }),
      runSuites: async () => 1,
      log: () => {},
    });
    assert.equal(code, 1);
    assert.equal(stopCount, 1);
  }

  // Case 2: runSuites throws -> stop still called once and main returns non-zero
  {
    let stopCount = 0;
    const code = await main([], {
      findPostgresBin: () => '/pg/bin',
      startDisposablePostgres: async () => ({
        url: 'postgres://sigil@127.0.0.1:55432/sigil_test',
        port: 55432,
        dataDir: '/tmp/fake-data',
        stop: async () => {
          stopCount += 1;
        },
      }),
      runSuites: async () => {
        throw new Error('suite runner crashed');
      },
      log: () => {},
    });
    assert.notEqual(code, 0);
    assert.equal(stopCount, 1);
  }

  // Case 3: runSuites resolves 0 -> returns 0 and stop called once
  {
    let stopCount = 0;
    const code = await main([], {
      findPostgresBin: () => '/pg/bin',
      startDisposablePostgres: async () => ({
        url: 'postgres://sigil@127.0.0.1:55432/sigil_test',
        port: 55432,
        dataDir: '/tmp/fake-data',
        stop: async () => {
          stopCount += 1;
        },
      }),
      runSuites: async () => 0,
      log: () => {},
    });
    assert.equal(code, 0);
    assert.equal(stopCount, 1);
  }
});

test('startDisposablePostgres stops and cleans up when a start step fails', async () => {
  const calls = [];
  const removed = [];
  const fakeDir = '/tmp/sigil-live-pg-fail123';

  async function fakeRun(cmd, args) {
    calls.push({ cmd, args });
    if (cmd.endsWith('initdb')) {
      return { code: 0, stdout: 'ok', stderr: '' };
    }
    if (cmd.endsWith('pg_ctl') && args.includes('start')) {
      return { code: 1, stdout: '', stderr: 'SENTINEL_STDERR: port in use' };
    }
    if (cmd.endsWith('pg_ctl') && args.includes('stop')) {
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  await assert.rejects(
    startDisposablePostgres({
      pgBin: '/usr/lib/postgresql/16/bin',
      run: fakeRun,
      mkdtemp: () => fakeDir,
      rm: (dir) => removed.push(dir),
      freePort: async () => 54329,
      createDatabase: async () => {},
    }),
    (err) => {
      assert.match(err.message, /pg_ctl start/i);
      assert.ok(!err.message.includes('SENTINEL_STDERR'), 'must not leak full stderr output');
      return true;
    },
  );

  const stopCall = calls.find((c) => c.cmd.endsWith('pg_ctl') && c.args.includes('stop'));
  assert.ok(stopCall, 'expected pg_ctl stop to run during cleanup');
  assert.deepEqual(removed, [fakeDir]);
});

test('startDisposablePostgres builds a loopback trust cluster with a _test database', async () => {
  const calls = [];
  const removed = [];
  const createdDbs = [];
  const fakeDir = '/tmp/sigil-live-pg-ok456';
  const testPort = 54399;

  async function fakeRun(cmd, args) {
    calls.push({ cmd, args });
    return { code: 0, stdout: '', stderr: '' };
  }

  const cluster = await startDisposablePostgres({
    pgBin: '/usr/lib/postgresql/16/bin',
    run: fakeRun,
    mkdtemp: () => fakeDir,
    rm: (dir) => removed.push(dir),
    freePort: async () => testPort,
    createDatabase: async ({ port }) => {
      createdDbs.push(port);
    },
  });

  assert.equal(cluster.url, `postgres://sigil@127.0.0.1:${testPort}/sigil_test`);
  assert.equal(cluster.port, testPort);
  assert.equal(cluster.dataDir, path.join(fakeDir, 'data'));
  assert.deepEqual(createdDbs, [testPort]);

  const initdbCall = calls.find((c) => c.cmd.endsWith('initdb'));
  assert.ok(initdbCall, 'initdb must be called');
  const initArgsStr = initdbCall.args.join(' ');
  assert.match(initArgsStr, /-U sigil/);
  assert.match(initArgsStr, /--auth=trust/);

  const startCall = calls.find((c) => c.cmd.endsWith('pg_ctl') && c.args.includes('start'));
  assert.ok(startCall, 'pg_ctl start must be called');
  const oIndex = startCall.args.indexOf('-o');
  assert.notEqual(oIndex, -1, 'pg_ctl start must pass -o');
  const oVal = startCall.args[oIndex + 1];
  assert.match(oVal, /listen_addresses=127\.0\.0\.1/);
  assert.ok(oVal.includes(String(testPort)));

  await cluster.stop();
  await cluster.stop(); // idempotent second call
  assert.equal(removed.length, 1);
  assert.equal(removed[0], fakeDir);
});

test(
  'real disposable cluster starts, answers SELECT 1, and is removed on stop',
  { skip: !process.env.SIGIL_PG_BIN && 'set SIGIL_PG_BIN to run', timeout: 60000 },
  async () => {
    const pgBin = findPostgresBin({ env: process.env });
    assert.ok(pgBin, 'expected SIGIL_PG_BIN to resolve');
    const cluster = await startDisposablePostgres({ pgBin });
    try {
      assert.match(cluster.url, /_test$/);
      const client = new pg.Client({ connectionString: cluster.url });
      await client.connect();
      const res = await client.query('SELECT 1 AS ok');
      await client.end();
      assert.equal(res.rows[0].ok, 1);
    } finally {
      await cluster.stop();
    }
    assert.equal(fs.existsSync(cluster.dataDir), false, 'dataDir must be removed after stop()');
  },
);
