import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

// Mirrors the temp-registry + child-process-spawn scaffolding in
// sigil/cli/relay-up-domain.test.mjs verbatim.
const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');

function tmpCwdWithRegistry() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relay-p2p-test-'));
  execFileSync(process.execPath, [sigilCli, 'init', 'alice'], { cwd, encoding: 'utf8' });
  return cwd;
}

test('sigil relay up --p2p logs a listen multiaddr', async () => {
  const cwd = tmpCwdWithRegistry(); // sigil init alice writes .sigil/alice.identity.json (has the private key p2p needs)
  const child = spawn(process.execPath, [
    sigilCli, 'relay', 'up', '--port', '0', '--p2p',
    '--p2p-identity', path.join('.sigil', 'alice.identity.json'),
  ], { cwd });
  try {
    const output = await new Promise((resolve, reject) => {
      let buf = '';
      const onData = (chunk) => {
        buf += chunk;
        if (/\/ip4\/127\.0\.0\.1\/tcp\/\d+\/p2p\/\w+/.test(buf)) { child.stdout.off('data', onData); resolve(buf); }
      };
      child.stdout.on('data', onData);
      child.on('exit', (code) => reject(new Error(`sigil relay up exited early with code ${code}: ${buf}`)));
      setTimeout(() => reject(new Error(`timed out waiting for a p2p listen multiaddr: ${buf}`)), 5000);
    });
    assert.match(output, /\/ip4\/127\.0\.0\.1\/tcp\/\d+\/p2p\/\w+/);
  } finally {
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    for (let attempt = 0; ; attempt++) {
      try { fs.rmSync(cwd, { recursive: true, force: true }); break; }
      catch (error) { if (attempt >= 10 || error.code !== 'EPERM') throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
  }
});

test('sigil relay up without --p2p never starts a libp2p host (no p2p listen line)', async () => {
  const cwd = tmpCwdWithRegistry();
  const child = spawn(process.execPath, [sigilCli, 'relay', 'up', '--port', '0'], { cwd });
  try {
    const output = await new Promise((resolve, reject) => {
      let buf = '';
      const onData = (chunk) => {
        buf += chunk;
        if (buf.includes('Sigil relay listening on')) { child.stdout.off('data', onData); resolve(buf); }
      };
      child.stdout.on('data', onData);
      child.on('exit', (code) => reject(new Error(`sigil relay up exited early with code ${code}: ${buf}`)));
      setTimeout(() => reject(new Error(`timed out waiting for relay to start: ${buf}`)), 5000);
    });
    assert.doesNotMatch(output, /sigil relay p2p listening on/);
  } finally {
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    for (let attempt = 0; ; attempt++) {
      try { fs.rmSync(cwd, { recursive: true, force: true }); break; }
      catch (error) { if (attempt >= 10 || error.code !== 'EPERM') throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
  }
});
