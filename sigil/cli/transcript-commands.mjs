// Issue #295: `sigil room export` writes a room transcript with the envelopes
// and sender public keys; `sigil verify <file>` checks it with no relay access.
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  TRANSCRIPT_FORMAT,
  TRANSCRIPT_VERSION,
  bytesToBase64url,
  formatProblem,
  verifyTranscript,
} from '../contracts/v1/transcript-verify.mjs';
import {
  formatHandoffProblem,
  verifyHandoffMemory,
} from '../contracts/v1/handoff-memory-gate.mjs';

export const ROOM_EXPORT_USAGE = 'usage: sigil room export --room <room_id> --out <file> [--database-url url]';
export const VERIFY_USAGE = 'usage: sigil verify <file> [--pin <keys.json>] [--json]';
export const VERIFY_HANDOFF_USAGE = 'usage: sigil verify-handoff <handoff.json> [--transcript <transcript.json>] [--pin <keys.json>] [--json]';

const PAGE = 500;

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function spkiOf(publicKey) {
  const keyObject = typeof publicKey === 'string' || Buffer.isBuffer(publicKey)
    ? (Buffer.isBuffer(publicKey) ? crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' }) : crypto.createPublicKey(publicKey))
    : publicKey;
  return bytesToBase64url(keyObject.export({ type: 'spki', format: 'der' }));
}

const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? null);

/**
 * Pure transcript builder. `rows` are room history items ({ room_seq,
 * message_id, canonical_bytes, envelope }) in room_seq order; `endpoints`
 * maps endpoint_id to a trusted-endpoint entry ({ keys: Map }).
 */
export function buildTranscript({ roomId, rows, endpoints, now = new Date() }) {
  const used = new Map();
  for (const row of rows) {
    const endpointId = row.envelope.sender.endpoint_id;
    used.set(`${endpointId}\n${row.envelope.signature.key_id}`, [endpointId, row.envelope.signature.key_id]);
  }
  const keys = [];
  for (const [endpointId, keyId] of used.values()) {
    const key = endpoints.get(endpointId)?.keys?.get(keyId);
    if (!key?.public_key) continue;
    keys.push({
      endpoint_id: endpointId,
      key_id: keyId,
      public_key_spki: spkiOf(key.public_key),
      status: key.status ?? null,
      valid_from: iso(key.valid_from),
      valid_until: iso(key.valid_until),
    });
  }
  const seqs = rows.map((row) => String(row.room_seq));
  return {
    format: TRANSCRIPT_FORMAT,
    version: TRANSCRIPT_VERSION,
    room_id: roomId,
    exported_at: now.toISOString(),
    first_seq: '1',
    last_seq: seqs.length ? seqs[seqs.length - 1] : '0',
    count: rows.length,
    keys,
    entries: rows.map((row) => ({
      room_seq: String(row.room_seq),
      message_id: row.message_id,
      canonical_bytes: row.canonical_bytes ?? null,
      envelope: row.envelope,
    })),
  };
}

/** `sigil room export`; `withRepository(fn)` supplies the database repository. */
export async function runRoomExport(argv, { withRepository, now = () => new Date(), out = (line) => console.log(line) } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { room: { type: 'string' }, out: { type: 'string' }, 'database-url': { type: 'string' } }, allowPositionals: false }));
  } catch (error) {
    throw usageError(`${ROOM_EXPORT_USAGE} (${error.message})`);
  }
  if (!values.room) throw usageError(`${ROOM_EXPORT_USAGE} (missing --room)`);
  if (!values.out) throw usageError(`${ROOM_EXPORT_USAGE} (missing --out)`);
  const transcript = await withRepository(async (repository) => {
    const rows = [];
    let after = 0n;
    for (;;) {
      const page = await repository.listRoomMessages(values.room, after, PAGE);
      rows.push(...page);
      if (page.length < PAGE) break;
      after = BigInt(page[page.length - 1].room_seq);
    }
    const endpoints = new Map();
    for (const row of rows) {
      const id = row.envelope.sender.endpoint_id;
      if (!endpoints.has(id)) endpoints.set(id, await repository.lookupTrustedEndpoint(id));
    }
    return buildTranscript({ roomId: values.room, rows, endpoints, now: now() });
  });
  fs.writeFileSync(values.out, `${JSON.stringify(transcript, null, 2)}\n`);
  out(`exported ${transcript.count} entries and ${transcript.keys.length} keys from room ${values.room} to ${values.out}`);
  return transcript;
}

/** `sigil verify <file>`. Exit 0 verified, 1 verification failed, 2 usage or unreadable file. */
export async function runVerify(argv, { out = (line) => console.log(line) } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { pin: { type: 'string' }, json: { type: 'boolean', default: false } }, allowPositionals: true });
  } catch (error) {
    throw usageError(`${VERIFY_USAGE} (${error.message})`);
  }
  const [file, ...extra] = parsed.positionals;
  if (!file || extra.length) throw usageError(VERIFY_USAGE);
  let transcript;
  try { transcript = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { throw usageError(`cannot read ${file}: ${error.message}`); }
  let pinnedKeys = [];
  if (parsed.values.pin) {
    try {
      const pinDoc = JSON.parse(fs.readFileSync(parsed.values.pin, 'utf8'));
      pinnedKeys = Array.isArray(pinDoc) ? pinDoc : pinDoc.keys;
      if (!Array.isArray(pinnedKeys)) throw new Error('expected an array of keys or a transcript with a keys array');
    } catch (error) { throw usageError(`cannot read --pin ${parsed.values.pin}: ${error.message}`); }
  }
  const result = await verifyTranscript(transcript, { pinnedKeys });
  if (parsed.values.json) {
    out(JSON.stringify(result));
  } else if (result.ok) {
    out(`verified ${result.checked} entries in room ${result.room_id ?? '(unknown)'}: all signatures valid, no missing or reordered entries`);
    if (!parsed.values.pin) out('note: public keys were taken from the transcript itself; pass --pin <keys.json> to check them against keys you already trust');
  } else {
    out(`FAILED: ${result.problems.length} problem(s) in room ${result.room_id ?? '(unknown)'}`);
    for (const problem of result.problems) out(formatProblem(problem));
  }
  return result.ok ? 0 : 1;
}

/** `sigil verify-handoff <handoff.json>`. Exit 0 verified, 1 rejected, 2 usage or unreadable file. */
export async function runVerifyHandoff(argv, { out = (line) => console.log(line) } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        transcript: { type: 'string' },
        pin: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
  } catch (error) {
    throw usageError(`${VERIFY_HANDOFF_USAGE} (${error.message})`);
  }
  const [file, ...extra] = parsed.positionals;
  if (!file || extra.length) throw usageError(VERIFY_HANDOFF_USAGE);

  let handoff;
  try { handoff = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { throw usageError(`cannot read ${file}: ${error.message}`); }

  let transcript;
  if (parsed.values.transcript) {
    try { transcript = JSON.parse(fs.readFileSync(parsed.values.transcript, 'utf8')); } catch (error) { throw usageError(`cannot read --transcript ${parsed.values.transcript}: ${error.message}`); }
  }

  let pinnedKeys = [];
  if (parsed.values.pin) {
    try {
      const pinDoc = JSON.parse(fs.readFileSync(parsed.values.pin, 'utf8'));
      pinnedKeys = Array.isArray(pinDoc) ? pinDoc : pinDoc.keys;
      if (!Array.isArray(pinnedKeys)) throw new Error('expected an array of keys or a transcript with a keys array');
    } catch (error) { throw usageError(`cannot read --pin ${parsed.values.pin}: ${error.message}`); }
  }

  const result = await verifyHandoffMemory(handoff, { transcript, pinnedKeys });
  if (parsed.values.json) {
    out(JSON.stringify(result));
  } else if (result.ok) {
    out(`verified handoff (${result.budget.file_count}/${result.budget.max_files} files, ${result.budget.total_chars}/${result.budget.max_chars} chars, ${result.checked_assertions} corroborated assertion(s)) in room ${result.room_id ?? '(unknown)'}`);
  } else {
    out(`FAILED: ${result.problems.length} handoff problem(s) in room ${result.room_id ?? '(unknown)'}`);
    for (const problem of result.problems) out(formatHandoffProblem(problem));
  }
  return result.ok ? 0 : 1;
}
