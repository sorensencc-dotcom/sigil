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

  const wireCallMatch = sigilSource.match(/wireDataProtocol\(p2pHost, \{([\s\S]*?)\n {4}\}\);/);
  assert.ok(wireCallMatch, 'could not locate the wireDataProtocol(p2pHost, {...}) call site in sigil.mjs -- update this test\'s regex if it moved/changed shape');
  const wireOptions = wireCallMatch[1];
  // Parity is structural now: wireDataProtocol and createRelayServer are both
  // handed the one buildAcceptOptions builder, and that builder's base carries
  // federationIdentity / onPersisted / stream_seq (accept-options.mjs rejects a
  // base that omits any shared key).
  assert.match(wireOptions, /\bbuildAcceptOptions\b/, 'wireDataProtocol must be handed the shared buildAcceptOptions builder');
  const httpCallMatch = sigilSource.match(/server = createRelayServer\(\{([\s\S]*?)\}\);/);
  assert.ok(httpCallMatch, 'could not locate the server = createRelayServer({...}) call site in sigil.mjs -- update this test\'s regex if it moved/changed shape');
  assert.match(httpCallMatch[1], /\bbuildAcceptOptions\b/, 'createRelayServer must be handed the shared buildAcceptOptions builder');
  const baseMatch = sigilSource.match(/createAcceptOptionsBuilder\(\{([\s\S]*?)\n  \}\);/);
  assert.ok(baseMatch, 'could not locate the createAcceptOptionsBuilder({...}) base in sigil.mjs');
  assert.match(baseMatch[1], /\bfederationIdentity\b/);
  assert.match(baseMatch[1], /\bstream_seq\b/);
  assert.match(baseMatch[1], /onPersisted:\s*createOnPersisted\(stream[,)]/);
});

// Regression for TODOS.md m7: --p2p used to hard-enable mDNS with no
// opt-out. A real end-to-end assertion would need two child-process relays
// on the same multicast segment and is exactly the "multi-host mDNS
// verification" TODOS.md already tracks as a separate, unstarted item --
// static source inspection is the direct way to pin the flag wiring itself.
test('--p2p-no-mdns flag wires enableMdns: false into createP2pHost', () => {
  const sigilSource = fs.readFileSync(sigilCli, 'utf8');
  assert.match(sigilSource, /'p2p-no-mdns':\s*\{\s*type:\s*'boolean'\s*\}/, 'parseArgs options no longer declare p2p-no-mdns as a boolean flag');
  assert.match(sigilSource, /enableMdns:\s*!args\.values\['p2p-no-mdns'\]/, 'createP2pHost call site no longer derives enableMdns from --p2p-no-mdns');
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
      setTimeout(() => reject(new Error(`timed out waiting for a p2p listen multiaddr: ${buf}`)), 25_000);
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
      setTimeout(() => reject(new Error(`timed out waiting for relay to start: ${buf}`)), 15_000);
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
