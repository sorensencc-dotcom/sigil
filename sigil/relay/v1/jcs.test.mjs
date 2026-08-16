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
