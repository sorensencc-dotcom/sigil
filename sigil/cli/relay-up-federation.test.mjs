import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

import { freeDistinctPorts } from '../scripts/test-free-ports.mjs';

const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relayfed-test-'));

function runRelayUp(args, cwd) {
  return execFileSync(process.execPath, [sigilCli, 'relay', 'up', ...args], { cwd, encoding: 'utf8', timeout: 15_000 });
}

test('--federation-mode bogus aborts before binding', () => {
  const cwd = tmp();
  try {
    execFileSync(process.execPath, [sigilCli, 'init', 'a', '--domain', 'local'], { cwd, encoding: 'utf8' });
    assert.throws(
      () => runRelayUp(['--registry', 'registry.json', '--domain', 'local', '--federation-mode', 'bogus', '--federation-identity', '.sigil/a.identity.json'], cwd),
      (e) => /--federation-mode must be "sync" or "queue"/.test(e.stderr ?? e.message),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('--federation-mode queue without --database-url aborts', () => {
  const cwd = tmp();
  try {
    execFileSync(process.execPath, [sigilCli, 'init', 'a', '--domain', 'local'], { cwd, encoding: 'utf8' });
    assert.throws(
      () => runRelayUp(['--registry', 'registry.json', '--domain', 'local', '--federation-mode', 'queue', '--federation-identity', '.sigil/a.identity.json'], cwd),
      (e) => /--federation-mode queue requires --database-url/.test(e.stderr ?? e.message),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('--federation-mode sync without --federation-identity aborts', () => {
  const cwd = tmp();
  try {
    execFileSync(process.execPath, [sigilCli, 'init', 'a', '--domain', 'local'], { cwd, encoding: 'utf8' });
    assert.throws(
      () => runRelayUp(['--registry', 'registry.json', '--domain', 'local', '--federation-mode', 'sync'], cwd),
      (e) => /--federation-mode requires --federation-identity/.test(e.stderr ?? e.message),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('--federation-mode sync without --domain aborts', () => {
  const cwd = tmp();
  try {
    execFileSync(process.execPath, [sigilCli, 'init', 'a', '--domain', 'local'], { cwd, encoding: 'utf8' });
    assert.throws(
      () => runRelayUp(['--registry', 'registry.json', '--federation-mode', 'sync', '--federation-identity', '.sigil/a.identity.json'], cwd),
      (e) => /--federation-mode requires --domain/.test(e.stderr ?? e.message),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('--federation-identity pointing at a missing file aborts', () => {
  const cwd = tmp();
  try {
    execFileSync(process.execPath, [sigilCli, 'init', 'a', '--domain', 'local'], { cwd, encoding: 'utf8' });
    assert.throws(
      () => runRelayUp(['--registry', 'registry.json', '--domain', 'local', '--federation-mode', 'sync', '--federation-identity', '/nonexistent/path.json'], cwd),
      (e) => /No identity file at/.test(e.stderr ?? e.message),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('--federation-mode queue without --database-url names in-memory in error message', () => {
  const cwd = tmp();
  try {
    execFileSync(process.execPath, [sigilCli, 'init', 'a', '--domain', 'local'], { cwd, encoding: 'utf8' });
    assert.throws(
      () => runRelayUp(['--registry', 'registry.json', '--domain', 'local', '--federation-mode', 'queue', '--federation-identity', '.sigil/a.identity.json'], cwd),
      (e) => /in-memory relays have no durable outbox/.test(e.stderr ?? e.message),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('relay up starts federation reaper when given live Postgres and queue mode', { skip: !process.env.SIGIL_TEST_DATABASE_URL, timeout: 90_000 }, async () => {
  const dbUrl = process.env.SIGIL_TEST_DATABASE_URL;
  const cwd = tmp();

  try {
    execFileSync(process.execPath, [sigilCli, 'init', 'a', '--domain', 'local'], { cwd, encoding: 'utf8' });
    execFileSync(process.execPath, [sigilCli, 'init', 'endpoint1', '--federation-owner', 'usr_1@local', '--domain', 'local', '--registry', 'registry.json'], { cwd, encoding: 'utf8' });

    const [port, streamPort, publicPort] = await freeDistinctPorts(3);

    const child = spawn(process.execPath, [
      sigilCli, 'relay', 'up',
      '--registry', 'registry.json',
      '--domain', 'local',
      '--federation-mode', 'queue',
      '--federation-identity', '.sigil/a.identity.json',
      '--database-url', dbUrl,
      '--port', String(port),
      '--stream-port', String(streamPort),
      '--public-port', String(publicPort),
      '--room-bot-key-wrap-key', 'SIGIL_TEST_BOT_WRAP'
    ], {
      cwd,
      env: { ...process.env, SIGIL_TEST_BOT_WRAP: Buffer.alloc(32, 7).toString('base64') }
    });

    let output = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`relay did not start: ${output}`)), 30_000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('Federation outbox reaper running')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.once('exit', (code) => reject(new Error(`relay exited ${code}: ${output}`)));
    });

    assert.match(output, /Federation outbox reaper running/);

    if (child) {
      child.kill('SIGTERM');
      if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve));
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
