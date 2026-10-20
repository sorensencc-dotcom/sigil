import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');

function fixtureCwd() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relay-bind-test-'));
  execFileSync(process.execPath, [sigilCli, 'init', `test_${crypto.randomUUID().replaceAll('-', '')}`], { cwd, encoding: 'utf8' });
  return cwd;
}

async function occupiedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  return { port: server.address().port, server };
}

async function freePort() {
  const { port, server } = await occupiedPort();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function assertFailedPromptly(result, output, listener) {
  assert.equal(result.error?.code, undefined, `${listener} bind hung: ${output}`);
  assert.notEqual(result.status, 0, output);
  assert.match(output, new RegExp(`${listener} listener failed to bind`));
  assert.match(output, /EADDRINUSE|address already in use/i);
}

test('relay up fails closed when relay listener cannot bind', async () => {
  const occupied = await occupiedPort();
  try {
    const cwd = fixtureCwd();
    const result = spawnSync(process.execPath, [sigilCli, 'relay', 'up', '--port', String(occupied.port), '--stream-port', '0'], { cwd, encoding: 'utf8', timeout: 5_000 });
    assertFailedPromptly(result, `${result.stderr}${result.stdout}`, 'relay');
  } finally {
    await new Promise((resolve) => occupied.server.close(resolve));
  }
});

test('relay up fails closed when reply ingress listener cannot bind', { skip: !process.env.SIGIL_TEST_DATABASE_URL, timeout: 60_000 }, async () => {
  const occupied = await occupiedPort();
  try {
    const cwd = fixtureCwd();
    let port;
    do port = await freePort(); while (port === occupied.port - 2);
    let streamPort;
    do streamPort = await freePort(); while (streamPort === occupied.port || streamPort === port + 2);
    const env = { ...process.env, SIGIL_TEST_BOT_WRAP: Buffer.alloc(32, 7).toString('base64') };
    const result = spawnSync(process.execPath, [sigilCli, 'relay', 'up', '--port', String(port), '--stream-port', String(streamPort), '--database-url', process.env.SIGIL_TEST_DATABASE_URL, '--room-bot-key-wrap-key', 'SIGIL_TEST_BOT_WRAP', '--ingress-origin', 'https://relay.example', '--ingress-port', String(occupied.port)], { cwd, env, encoding: 'utf8', timeout: 5_000 });
    assertFailedPromptly(result, `${result.stderr}${result.stdout}`, 'reply ingress');
  } finally {
    await new Promise((resolve) => occupied.server.close(resolve));
  }
});
