import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, assertCanonicalizable } from './jcs.mjs';

test('JCS: object keys are sorted regardless of input order', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('JCS: nested object and array ordering is normalized', () => {
  const a = { z: [{ y: 1, x: 2 }], m: { b: 1, a: 2 } };
  const b = { m: { a: 2, b: 1 }, z: [{ x: 2, y: 1 }] };
  assert.equal(canonicalJson(a), canonicalJson(b));
});

test('JCS: reparsing differently-formatted JSON text produces identical bytes', () => {
  const fromCompact = JSON.parse('{"a":1,"b":2}');
  const fromSpaced = JSON.parse('{ "b" : 2 ,  "a" : 1 }');
  assert.equal(canonicalJson(fromCompact), canonicalJson(fromSpaced));
});

test('JCS: unicode strings are preserved without re-escaping', () => {
  assert.equal(canonicalJson({ name: 'café 🔑' }), '{"name":"café 🔑"}');
});

test('assertCanonicalizable rejects non-finite numbers and undefined', () => {
  assert.throws(() => assertCanonicalizable({ a: NaN }), /unsupported value/);
  assert.throws(() => assertCanonicalizable({ a: Infinity }), /unsupported value/);
  assert.throws(() => assertCanonicalizable({ a: undefined }), /unsupported value/);
});

test('assertCanonicalizable accepts strings, booleans, finite numbers, nested arrays/objects', () => {
  assert.doesNotThrow(() => assertCanonicalizable({ a: 'x', b: true, c: 1.5, d: [1, { e: null }] }));
});

test('JCS: canonical bytes for the envelope example fixture shape are pinned', async () => {
  const fs = await import('node:fs');
  const template = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  const unsigned = { ...template };
  delete unsigned.signature;
  assert.equal(
    canonicalJson(unsigned),
    '{"body":{"deadline":"2026-08-13T00:00:00Z","dependencies":[],"instruction":"Review the API migration.","success_criteria":["Identify breaking route changes"],"task_id":"task_01JEXAMPLE"},"capabilities":[],"context_refs":[],"conversation_id":"conv_01JEXAMPLE","correlation_id":null,"created_at":"2026-08-12T00:00:00Z","expires_at":"2026-08-13T00:00:00Z","idempotency_key":"send_01JEXAMPLE","message_id":"msg_01JEXAMPLE","message_type":"task.request","protocol":"sigil/1","recipient":{"endpoint_id":"ep_claude","owner_id":"usr_claude_owner"},"sender":{"endpoint_id":"ep_codex","kind":"agent","owner_id":"usr_codex_owner"}}'
  );
});
