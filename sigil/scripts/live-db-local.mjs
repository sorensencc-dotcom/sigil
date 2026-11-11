import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(here, '..', '..');
const liveDbTestsScript = path.join(here, 'live-db-tests.mjs');

export function findPostgresBin({
  env = process.env,
  platform = process.platform,
  exists = fs.existsSync,
  listDir = (d) => fs.readdirSync(d),
  repoRoot = defaultRepoRoot,
} = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const ext = platform === 'win32' ? '.exe' : '';
  const required = [`initdb${ext}`, `pg_ctl${ext}`, `postgres${ext}`];

  const candidates = [];

  if (env.SIGIL_PG_BIN) {
    candidates.push(env.SIGIL_PG_BIN);
  }

  if (env.PATH) {
    for (const entry of env.PATH.split(p.delimiter)) {
      if (entry) candidates.push(entry);
    }
  }

  if (platform === 'linux') {
    try {
      const versions = listDir('/usr/lib/postgresql')
        .filter((name) => /^\d+$/.test(name))
        .sort((a, b) => Number(b) - Number(a));
      for (const ver of versions) {
        candidates.push(p.join('/usr/lib/postgresql', ver, 'bin'));
      }
    } catch {
      // ignore missing /usr/lib/postgresql
    }
  }

  if (repoRoot) {
    candidates.push(
      p.join(
        repoRoot,
        'node_modules',
        '@embedded-postgres',
        `${platform}-${process.arch}`,
        'native',
        'bin',
      ),
    );
  }

  for (const dir of candidates) {
    if (required.every((bin) => exists(p.join(dir, bin)))) {
      return dir;
    }
  }

  return null;
}

function defaultRun(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function defaultFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function defaultCreateDatabase({ port }) {
  const client = new pg.Client({
    connectionString: `postgres://sigil@127.0.0.1:${port}/postgres`,
  });
  await client.connect();
  try {
    await client.query('CREATE DATABASE sigil_test');
  } finally {
    await client.end().catch(() => {});
  }
}

export async function startDisposablePostgres({
  pgBin,
  run = defaultRun,
  mkdtemp = (p) => fs.mkdtempSync(p),
  rm = (p) => fs.rmSync(p, { recursive: true, force: true }),
  tmpRoot = os.tmpdir(),
  freePort = defaultFreePort,
  createDatabase = defaultCreateDatabase,
} = {}) {
  const dir = mkdtemp(path.join(tmpRoot, 'sigil-live-pg-'));
  const dataDir = path.join(dir, 'data');
  const logFile = path.join(dir, 'postgres.log');
  const isPosixBin = pgBin.includes('/') && !pgBin.includes('\\');
  const binPath = isPosixBin ? path.posix : path;
  const ext = process.platform === 'win32' && !isPosixBin ? '.exe' : '';
  const initdbBin = binPath.join(pgBin, `initdb${ext}`);
  const pgCtlBin = binPath.join(pgBin, `pg_ctl${ext}`);

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    try {
      await run(pgCtlBin, ['-D', dataDir, '-m', 'fast', '-w', 'stop']);
    } catch {
      // ignore stop failure
    }
    try {
      rm(dir);
    } catch {
      // ignore rm failure
    }
  }

  try {
    const port = await freePort();

    let initRes;
    try {
      initRes = await run(initdbBin, ['-D', dataDir, '-U', 'sigil', '--auth=trust', '-E', 'UTF8']);
    } catch {
      throw new Error('initdb failed');
    }
    if (!initRes || initRes.code !== 0) {
      throw new Error(`initdb failed (exit code ${initRes?.code ?? 1})`);
    }

    let startRes;
    try {
      startRes = await run(pgCtlBin, [
        '-D',
        dataDir,
        '-o',
        `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`,
        '-l',
        logFile,
        '-w',
        'start',
      ]);
    } catch {
      throw new Error('pg_ctl start failed');
    }
    if (!startRes || startRes.code !== 0) {
      throw new Error(`pg_ctl start failed (exit code ${startRes?.code ?? 1})`);
    }

    try {
      await createDatabase({ port });
    } catch {
      throw new Error('createDatabase sigil_test failed');
    }

    const url = `postgres://sigil@127.0.0.1:${port}/sigil_test`;
    return { url, port, dataDir, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

function defaultRunSuites({ url, argv = [] }) {
  return new Promise((resolve, reject) => {
    const args =
      argv.length > 0
        ? ['--test', '--test-concurrency=1', '--test-timeout=30000', ...argv]
        : [liveDbTestsScript];
    const child = spawn(process.execPath, args, {
      env: { ...process.env, SIGIL_TEST_DATABASE_URL: url },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const findBin = deps.findPostgresBin ?? findPostgresBin;
  const startPg = deps.startDisposablePostgres ?? startDisposablePostgres;
  const runSuites = deps.runSuites ?? defaultRunSuites;
  const log = deps.log ?? console.log;

  const pgBin = findBin();
  if (!pgBin) {
    log(
      `PostgreSQL binaries not found. Set SIGIL_PG_BIN, install PostgreSQL server binaries, or run: npm i --no-save @embedded-postgres/${process.platform}-${process.arch}`,
    );
    return 2;
  }

  const cluster = await startPg({ pgBin });
  log(`Disposable PostgreSQL on 127.0.0.1:${cluster.port}`);

  const onSignal = () => {
    Promise.resolve(cluster.stop()).catch(() => {});
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let exitCode = 1;
  try {
    const code = await runSuites({ url: cluster.url, argv });
    exitCode = typeof code === 'number' ? code : 1;
  } catch {
    exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await cluster.stop();
  }

  log(exitCode === 0 ? 'Live PostgreSQL gate passed.' : `Live PostgreSQL gate failed (exit ${exitCode}).`);
  return exitCode;
}

const isDirectRun = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  process.exitCode = await main();
}
