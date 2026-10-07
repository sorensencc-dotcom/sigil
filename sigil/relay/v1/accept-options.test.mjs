import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ACCEPT_OPTION_KEYS, createAcceptOptionsBuilder } from './accept-options.mjs';

const base = Object.fromEntries(ACCEPT_OPTION_KEYS.map((key) => [key, key === 'persist' ? true : `v_${key}`]));

test('builder returns every key and applies per-transport overrides', () => {
  const build = createAcceptOptionsBuilder(base);
  const options = build({ request_id: 'req_1' });
  for (const key of ACCEPT_OPTION_KEYS) assert.ok(key in options, key);
  assert.equal(options.request_id, 'req_1');
  assert.equal(options.systemIdentity, 'v_systemIdentity');
});

test('builder refuses a base that omits a shared option', () => {
  const { systemIdentity, ...partial } = base;
  assert.throws(() => createAcceptOptionsBuilder(partial), /systemIdentity/);
});

test('an explicit undefined is allowed: a relay without a system identity still passes the key', () => {
  assert.doesNotThrow(() => createAcceptOptionsBuilder({ ...base, systemIdentity: undefined }));
});

// Every acceptEnvelopeAsync call site must take its options straight from
// buildAcceptOptions(...), inline or via a const initialised by it; a literal or a
// ternary fallback fails. The human send route
// (room-routes.mjs) has no acceptEnvelopeAsync call yet; add it here when it lands.
const CALL_SITES = ['relay/v1/http-server.mjs', 'relay/v1/transport-libp2p/p2p-data-protocol.mjs', 'ingress/v1/agentmail-adapter.mjs'];
const root = new URL('../../', import.meta.url);

for (const file of CALL_SITES) {
  test(`${file} passes buildAcceptOptions(...) directly to acceptEnvelopeAsync`, () => {
    const lines = fs.readFileSync(new URL(file, root), 'utf8').split('\n');
    const calls = lines.flatMap((line, i) => (/\bawait acceptEnvelopeAsync\(/.test(line) ? [i] : []));
    assert.ok(calls.length > 0, 'acceptEnvelopeAsync call found');
    for (const i of calls) {
      const window = lines.slice(i, i + 3).join('\n');
      const arg = window.match(/acceptEnvelopeAsync\(envelope,\s*([A-Za-z_$][\w$]*)/)?.[1];
      assert.ok(arg, `call at line ${i + 1} must pass a plain argument, not an object literal`);
      // Either buildAcceptOptions(...) inline, or an identifier initialised directly
      // from buildAcceptOptions(...) (a ternary or literal fallback does not match).
      const direct = arg === 'buildAcceptOptions';
      const viaVariable = lines.join(' ').includes(`const ${arg} = buildAcceptOptions(`);
      assert.ok(direct || viaVariable, `call at line ${i + 1} options must come from buildAcceptOptions(...)`);
    }
  });
}

test('no other non-test module calls acceptEnvelopeAsync', () => {
  const allowed = new Set([...CALL_SITES, 'relay/v1/accept-envelope.mjs']);
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.mjs') || entry.name.includes('.test.')) continue;
      const code = fs.readFileSync(full, 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*)/.test(line)).join('\n');
      if (/\bacceptEnvelopeAsync\(/.test(code)) found.push(full.pathname.slice(root.pathname.length));
    }
  };
  walk(root);
  const extra = found.filter((file) => !allowed.has(file));
  assert.deepEqual(extra, [], `new acceptEnvelopeAsync call site(s) outside the allowlist: ${extra.join(', ')}`);
});
