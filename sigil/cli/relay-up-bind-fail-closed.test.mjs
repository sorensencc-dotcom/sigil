import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freeDistinctPorts } from '../test-support/free-ports.mjs';

const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');

function fixtureCwd() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relay-bind-test-'));
  execFileSync(process.execPath, [sigilCli, 'init', `test_${crypto.randomUUID().replaceAll('-', '')}`], { cwd, encoding: 'utf8' });
  return cwd;
}

async function occupy(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', resolve).once('error', reject));
  return { port, server };
}

function assertFailedPromptly(result, output, listener) {
  assert.equal(result.error?.code, undefined, `${listener} bind hung: ${output}`);
  assert.notEqual(result.status, 0, output);
  assert.match(output, new RegExp(`${listener} listener failed to bind`));
  assert.match(output, /EADDRINUSE|address already in use/i);
}

test('relay up fails closed when relay listener cannot bind', async () => {
  const [relayPort, streamPort, publicPort] = await freeDistinctPorts(3);
  const occupied = await occupy(relayPort);
  try {
    const cwd = fixtureCwd();
    const result = spawnSync(process.execPath, [sigilCli, 'relay', 'up', '--port', String(relayPort), '--stream-port', String(streamPort), '--public-port', String(publicPort)], { cwd, encoding: 'utf8', timeout: 5_000 });
    assertFailedPromptly(result, `${result.stderr}${result.stdout}`, 'relay');
  } finally {
    await new Promise((resolve) => occupied.server.close(resolve));
  }
});

test('relay up fails closed when reply ingress listener cannot bind', { skip: !process.env.SIGIL_TEST_DATABASE_URL, timeout: 60_000 }, async () => {
  const [port, streamPort, publicPort, ingressPort] = await freeDistinctPorts(4);
  const occupied = await occupy(ingressPort);
  try {
    const cwd = fixtureCwd();
    const env = { ...process.env, SIGIL_TEST_BOT_WRAP: Buffer.alloc(32, 7).toString('base64') };
    const result = spawnSync(process.execPath, [sigilCli, 'relay', 'up', '--port', String(port), '--stream-port', String(streamPort), '--public-port', String(publicPort), '--database-url', process.env.SIGIL_TEST_DATABASE_URL, '--room-bot-key-wrap-key', 'SIGIL_TEST_BOT_WRAP', '--ingress-origin', 'https://relay.example', '--ingress-port', String(ingressPort)], { cwd, env, encoding: 'utf8', timeout: 5_000 });
    assertFailedPromptly(result, `${result.stderr}${result.stdout}`, 'reply ingress');
  } finally {
    await new Promise((resolve) => occupied.server.close(resolve));
  }
});
