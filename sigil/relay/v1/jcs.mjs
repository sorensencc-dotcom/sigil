// RFC 8785 JSON Canonicalization Scheme, shared by every module that signs
// or hashes envelope/action bytes (validate-envelope.mjs, action-hash.mjs).
// Replaces the hand-rolled per-module canonicalize() functions per the
// Tier-1-locked sigil-implementation-decisions-v1.0.md.
import canonicalize from 'canonicalize';

export function assertCanonicalizable(value, code = 'INVALID_ACTION') {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw Object.assign(new Error('Value contains an unsupported value'), { code });
    return;
  }
  if (Array.isArray(value)) { for (const item of value) assertCanonicalizable(item, code); return; }
  if (type === 'object') { for (const key of Object.keys(value)) assertCanonicalizable(value[key], code); return; }
  throw Object.assign(new Error('Value contains an unsupported value'), { code });
}

export function canonicalJson(value) {
  const text = canonicalize(value);
  if (text === undefined) throw Object.assign(new Error('Value cannot be canonicalized'), { code: 'INVALID_ENVELOPE' });
  return text;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(canonicalJson(value), 'utf8');
}
