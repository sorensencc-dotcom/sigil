// Relay-free verification core for an exported room transcript (issue #295).
//
// Pure ESM, no Node-only imports: it signs nothing, reads no files, and never
// touches the network. The only crypto is WebCrypto Ed25519, so the same
// module runs in Node >= 22 and (issue #270) in a browser. The CLI
// (`sigil verify`) and the browser verifier both call verifyTranscript(), so
// they cannot disagree.
//
// Transcript format (`sigil.room-transcript` v1):
//   { format, version, room_id, exported_at, first_seq, last_seq, count,
//     keys:    [{ endpoint_id, key_id, public_key_spki, status?, valid_from?, valid_until? }],
//     entries: [{ room_seq, message_id, canonical_bytes?, envelope }] }
// public_key_spki and canonical_bytes are base64url. canonical_bytes is the
// exact JCS byte string the relay stored and the sender signed; when absent
// the signed bytes are rebuilt as JCS(envelope without signature).
import { canonicalJson } from '../../relay/v1/jcs.mjs';

export const TRANSCRIPT_FORMAT = 'sigil.room-transcript';
export const TRANSCRIPT_VERSION = 1;

export const PROBLEM = Object.freeze({
  BAD_SIGNATURE: 'BAD_SIGNATURE',
  MALFORMED_ENTRY: 'MALFORMED_ENTRY',
  MISSING_KEY: 'MISSING_KEY',
  KEY_MISMATCH: 'KEY_MISMATCH',
  KEY_OUT_OF_WINDOW: 'KEY_OUT_OF_WINDOW',
  ENVELOPE_MISMATCH: 'ENVELOPE_MISMATCH',
  MISSING_ENTRY: 'MISSING_ENTRY',
  REORDERED: 'REORDERED',
  DUPLICATE_SEQ: 'DUPLICATE_SEQ',
  DUPLICATE_MESSAGE: 'DUPLICATE_MESSAGE',
  COUNT_MISMATCH: 'COUNT_MISMATCH',
});

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function base64urlToBytes(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSeq(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function keyRef(endpointId, keyId) {
  return JSON.stringify([endpointId, keyId]);
}

async function importKey(spki) {
  return globalThis.crypto.subtle.importKey('spki', base64urlToBytes(spki), { name: 'Ed25519' }, false, ['verify']);
}

function windowProblem(key, createdAt) {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return 'envelope created_at is not a valid timestamp';
  if (key.valid_from && created < Date.parse(key.valid_from)) return `signed before key valid_from ${key.valid_from}`;
  if (key.valid_until && created >= Date.parse(key.valid_until)) return `signed at or after key valid_until ${key.valid_until}`;
  return null;
}

// The bytes the sender signed. With canonical_bytes, also bind them to the
// envelope shown beside them so a tampered body cannot ride on a genuine
// signature over different bytes.
function signedBytesFor(entry, roomId) {
  const { envelope } = entry;
  const { signature: _signature, ...unsigned } = envelope;
  if (entry.canonical_bytes == null) return { bytes: encoder.encode(canonicalJson(unsigned)) };
  const bytes = base64urlToBytes(entry.canonical_bytes);
  let signed;
  try { signed = JSON.parse(decoder.decode(bytes)); } catch { return { problem: 'canonical_bytes is not valid JSON' }; }
  if (!isObject(signed)) return { problem: 'canonical_bytes is not a JSON object' };
  if (signed.message_id !== envelope.message_id) return { problem: 'signed message_id differs from the envelope' };
  if (signed.conversation_id !== envelope.conversation_id) return { problem: 'signed conversation_id differs from the envelope' };
  if (roomId != null && signed.conversation_id !== roomId) return { problem: 'signed conversation_id differs from the transcript room_id' };
  if (signed.sender?.endpoint_id !== envelope.sender?.endpoint_id) return { problem: 'signed sender differs from the envelope' };
  if (signed.idempotency_key !== envelope.idempotency_key) return { problem: 'signed idempotency_key differs from the envelope' };
  if (canonicalJson(signed.body) !== canonicalJson(envelope.body)) return { problem: 'signed body differs from the envelope body' };
  return { bytes };
}

/**
 * Verify an exported transcript. Never throws on bad content; returns
 * { ok, room_id, checked, problems }. Each problem carries `entry` (1-based
 * position in the file, or null for transcript-level problems), `room_seq`,
 * `message_id`, `code`, and a human `message`.
 *
 * @param {unknown} transcript parsed transcript JSON
 * @param {{ pinnedKeys?: Array<{endpoint_id:string,key_id:string,public_key_spki:string}> }} [options]
 *   pinnedKeys: keys the caller already trusts. A pinned (endpoint_id, key_id)
 *   must match the transcript's key byte for byte, and a pinned key is used
 *   even if the transcript omits it.
 */
export async function verifyTranscript(transcript, { pinnedKeys = [] } = {}) {
  const problems = [];
  const add = (code, message, entryIndex = null, entry = null) => problems.push({
    entry: entryIndex,
    room_seq: entry?.room_seq != null ? String(entry.room_seq) : null,
    message_id: typeof entry?.message_id === 'string' ? entry.message_id : null,
    code,
    message,
  });
  const result = (extra = {}) => ({ ok: problems.length === 0, room_id: null, checked: 0, problems, ...extra });

  if (!isObject(transcript) || transcript.format !== TRANSCRIPT_FORMAT) {
    add(PROBLEM.MALFORMED_ENTRY, `not a ${TRANSCRIPT_FORMAT} document`);
    return result();
  }
  if (transcript.version !== TRANSCRIPT_VERSION) {
    add(PROBLEM.MALFORMED_ENTRY, `unsupported transcript version ${JSON.stringify(transcript.version)}`);
    return result();
  }
  if (!Array.isArray(transcript.entries) || !Array.isArray(transcript.keys)) {
    add(PROBLEM.MALFORMED_ENTRY, 'entries and keys must be arrays');
    return result();
  }
  const roomId = typeof transcript.room_id === 'string' ? transcript.room_id : null;

  // Key table: transcript keys, checked against pins.
  const keys = new Map();
  for (const key of transcript.keys) {
    if (isObject(key) && typeof key.endpoint_id === 'string' && typeof key.key_id === 'string' && typeof key.public_key_spki === 'string') {
      keys.set(keyRef(key.endpoint_id, key.key_id), key);
    }
  }
  const pinned = new Map();
  for (const pin of pinnedKeys) {
    if (isObject(pin) && typeof pin.endpoint_id === 'string' && typeof pin.key_id === 'string' && typeof pin.public_key_spki === 'string') {
      pinned.set(keyRef(pin.endpoint_id, pin.key_id), pin);
    }
  }
  const mismatchedPins = new Set();
  for (const [ref, pin] of pinned) {
    const embedded = keys.get(ref);
    if (embedded && embedded.public_key_spki !== pin.public_key_spki) {
      mismatchedPins.add(ref);
      add(PROBLEM.KEY_MISMATCH, `key ${pin.key_id} of ${pin.endpoint_id} differs from the pinned key`);
    }
    if (!embedded) keys.set(ref, pin);
  }

  const imported = new Map();
  async function cryptoKey(ref, key) {
    if (!imported.has(ref)) imported.set(ref, importKey(key.public_key_spki).catch(() => null));
    return imported.get(ref);
  }

  // Sequence integrity, from the signed-over-nothing room_seq the relay stamps.
  const seen = new Map();
  const seenMessages = new Set();
  let maxSeq = null;
  const entries = transcript.entries;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const number = i + 1;
    if (!isObject(entry) || !isObject(entry.envelope)) {
      add(PROBLEM.MALFORMED_ENTRY, 'entry has no envelope', number, isObject(entry) ? entry : null);
      continue;
    }
    const seq = parseSeq(entry.room_seq);
    if (seq === null) {
      add(PROBLEM.MALFORMED_ENTRY, 'entry has no valid room_seq', number, entry);
    } else if (seen.has(seq)) {
      add(PROBLEM.DUPLICATE_SEQ, `room_seq ${seq} already used by entry ${seen.get(seq)}`, number, entry);
    } else {
      if (maxSeq !== null && seq < maxSeq) add(PROBLEM.REORDERED, `room_seq ${seq} appears after room_seq ${maxSeq}`, number, entry);
      seen.set(seq, number);
      if (maxSeq === null || seq > maxSeq) maxSeq = seq;
    }
    if (typeof entry.message_id === 'string') {
      if (seenMessages.has(entry.message_id)) add(PROBLEM.DUPLICATE_MESSAGE, `message_id ${entry.message_id} appears twice`, number, entry);
      seenMessages.add(entry.message_id);
    }
  }

  // Missing entries: every seq in [first_seq, last_seq] must be present.
  const firstDeclared = parseSeq(transcript.first_seq ?? 1) ?? 1n;
  const lastDeclared = parseSeq(transcript.last_seq);
  const upper = lastDeclared ?? maxSeq;
  if (upper !== null) {
    const holes = [];
    for (let s = firstDeclared; s <= upper; s += 1n) {
      if (!seen.has(s)) holes.push(s);
      if (holes.length > 1000) break;
    }
    for (const s of holes.slice(0, 50)) add(PROBLEM.MISSING_ENTRY, `room_seq ${s} is missing from the transcript`);
    if (holes.length > 50) add(PROBLEM.MISSING_ENTRY, `${holes.length - 50} more missing room_seq values not listed`);
  }
  if (transcript.count !== undefined && transcript.count !== entries.length) {
    add(PROBLEM.COUNT_MISMATCH, `header declares ${transcript.count} entries but the file has ${entries.length}`);
  }

  // Signatures.
  let checked = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const number = i + 1;
    if (!isObject(entry) || !isObject(entry.envelope)) continue;
    const { envelope } = entry;
    const signature = envelope.signature;
    const endpointId = envelope.sender?.endpoint_id;
    if (!isObject(signature) || signature.algorithm !== 'Ed25519' || typeof signature.key_id !== 'string' || typeof signature.value !== 'string') {
      add(PROBLEM.BAD_SIGNATURE, 'envelope has no complete Ed25519 signature', number, entry);
      continue;
    }
    if (typeof endpointId !== 'string') {
      add(PROBLEM.MALFORMED_ENTRY, 'envelope has no sender endpoint_id', number, entry);
      continue;
    }
    const ref = keyRef(endpointId, signature.key_id);
    const key = keys.get(ref);
    if (!key) {
      add(PROBLEM.MISSING_KEY, `no public key for ${endpointId} key ${signature.key_id}`, number, entry);
      continue;
    }
    if (mismatchedPins.has(ref)) {
      add(PROBLEM.KEY_MISMATCH, `key ${signature.key_id} of ${endpointId} differs from the pinned key`, number, entry);
      continue;
    }
    const outOfWindow = windowProblem(key, envelope.created_at);
    if (outOfWindow) {
      add(PROBLEM.KEY_OUT_OF_WINDOW, outOfWindow, number, entry);
      continue;
    }
    let signed;
    let signatureBytes;
    try {
      signed = signedBytesFor(entry, roomId);
      signatureBytes = base64urlToBytes(signature.value);
    } catch (error) {
      add(PROBLEM.MALFORMED_ENTRY, `cannot decode entry: ${error.message}`, number, entry);
      continue;
    }
    if (signed.problem) {
      add(PROBLEM.ENVELOPE_MISMATCH, signed.problem, number, entry);
      continue;
    }
    const publicKey = await cryptoKey(ref, key);
    if (!publicKey) {
      add(PROBLEM.MISSING_KEY, `public key for ${endpointId} key ${signature.key_id} is not a valid Ed25519 SPKI`, number, entry);
      continue;
    }
    checked += 1;
    let valid = false;
    try { valid = await globalThis.crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signatureBytes, signed.bytes); } catch { valid = false; }
    if (!valid) add(PROBLEM.BAD_SIGNATURE, `Ed25519 signature does not verify for ${endpointId} key ${signature.key_id}`, number, entry);
  }

  return result({ room_id: roomId, checked });
}

/** One line per problem, naming the entry number. Shared by CLI and browser. */
export function formatProblem(problem) {
  const where = problem.entry == null ? 'transcript' : `entry ${problem.entry}${problem.room_seq != null ? ` (room_seq ${problem.room_seq}${problem.message_id ? `, ${problem.message_id}` : ''})` : ''}`;
  return `${where}: ${problem.code}: ${problem.message}`;
}
