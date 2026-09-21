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

// Regression for final-review findings M1/M2/M3: the p2p `wireDataProtocol`
// call site silently omitted `federationIdentity`, `onPersisted`, and
// `stream_seq` even though the HTTP `createRelayServer` call site right next
// to it in the same function passed all three. Static source inspection
// (rather than exercising both transports end-to-end) is the most direct way
// to assert the two option sets stay in parity going forward -- the root
// cause the final review called out was exactly that no test compared them.
test('wireDataProtocol options stay in parity with createRelayServer/acceptEnvelopeAsync for federationIdentity/onPersisted/stream_seq', () => {
  const sigilSource = fs.readFileSync(sigilCli, 'utf8');
  const httpServerPath = path.resolve(path.dirname(sigilCli), '..', 'relay', 'v1', 'http-server.mjs');
  const httpServerSource = fs.readFileSync(httpServerPath, 'utf8');

  const wireCallMatch = sigilSource.match(/wireDataProtocol\(p2pHost, \{([\s\S]*?)\n {4}\}\);/);
  assert.ok(wireCallMatch, 'could not locate the wireDataProtocol(p2pHost, {...}) call site in sigil.mjs -- update this test\'s regex if it moved/changed shape');
  const wireOptions = wireCallMatch[1];

  // federationIdentity and stream_seq: sigil.mjs's own createRelayServer(...)
  // call site is the parity reference -- both transports are wired in the
  // same function and both accept these as direct CLI-derived values.
  const httpCallMatch = sigilSource.match(/server = createRelayServer\(\{([\s\S]*?)\}\);/);
  assert.ok(httpCallMatch, 'could not locate the server = createRelayServer({...}) call site in sigil.mjs -- update this test\'s regex if it moved/changed shape');
  for (const key of ['federationIdentity', 'stream_seq']) {
    assert.match(httpCallMatch[1], new RegExp(`\\b${key}\\b`), `sanity check: createRelayServer's options no longer mention ${key} -- update this parity test`);
    assert.match(wireOptions, new RegExp(`\\b${key}\\b`), `wireDataProtocol's options object is missing "${key}" (present in createRelayServer's options right below it) -- p2p-accepted envelopes will silently diverge from HTTP-accepted ones`);
  }

  // onPersisted: createRelayServer never receives it as a caller option (it
  // builds its own `acceptEnvelopeAsync` call internally using `stream`), so
  // the parity reference for this one is http-server.mjs's own
  // acceptEnvelopeAsync call site, which must use the shared
  // `createOnPersisted` factory -- the same factory wireDataProtocol's call
  // site must be handed, so both transports drive the exact same
  // stream.notify/notifyReceipt closure bound to the exact same `stream`.
  assert.match(httpServerSource, /onPersisted:\s*createOnPersisted\(stream\)/, 'sanity check: http-server.mjs\'s acceptEnvelopeAsync call site no longer uses the shared createOnPersisted(stream) factory -- update this parity test');
  assert.match(wireOptions, /onPersisted:\s*createOnPersisted\(stream\)/, 'wireDataProtocol\'s options object is missing "onPersisted: createOnPersisted(stream)" -- p2p-accepted envelopes will never notify WebSocket stream subscribers or emit delivery receipts');
});

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
      // libp2p startup can exceed five seconds on Windows under a cold Node process.
      setTimeout(() => reject(new Error(`timed out waiting for a p2p listen multiaddr: ${buf}`)), 15000);
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
