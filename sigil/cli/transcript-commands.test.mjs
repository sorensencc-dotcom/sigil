import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildTranscript, runRoomExport, runVerify } from './transcript-commands.mjs';
import { makeFixture } from '../contracts/v1/transcript-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, 'sigil.mjs');

function tempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-verify-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

test('runVerify: untouched export exits 0, tampered exits 1 naming the entry', async () => {
  const lines = [];
  const out = (line) => lines.push(line);
  const good = tempFile('good.json', makeFixture());
  assert.equal(await runVerify([good], { out }), 0);
  assert.match(lines.join('\n'), /verified 4 entries/);

  const tampered = makeFixture();
  tampered.entries[2].envelope.body.text = 'forged';
  lines.length = 0;
  assert.equal(await runVerify([tempFile('bad.json', tampered)], { out }), 1);
  assert.match(lines.join('\n'), /entry 3 \(room_seq 3, msg_3\)/);

  const reordered = makeFixture();
  [reordered.entries[0], reordered.entries[1]] = [reordered.entries[1], reordered.entries[0]];
  lines.length = 0;
  assert.equal(await runVerify([tempFile('re.json', reordered)], { out }), 1);
  assert.match(lines.join('\n'), /entry 2 .*REORDERED/);

  const missing = makeFixture();
  missing.entries.splice(1, 1);
  lines.length = 0;
  assert.equal(await runVerify([tempFile('miss.json', missing)], { out }), 1);
  assert.match(lines.join('\n'), /MISSING_ENTRY: room_seq 2 is missing/);
});

test('runVerify: usage errors and unreadable files exit 2, --json and --pin work', async () => {
  await assert.rejects(runVerify([]), (e) => e.exitCode === 2);
  await assert.rejects(runVerify([path.join(os.tmpdir(), 'sigil-no-such-transcript.json')]), (e) => e.exitCode === 2 && /cannot read/.test(e.message));
  await assert.rejects(runVerify([tempFile('junk.json', 'not json')]), (e) => e.exitCode === 2);

  const transcript = makeFixture();
  const file = tempFile('t.json', transcript);
  const lines = [];
  assert.equal(await runVerify([file, '--json', '--pin', tempFile('pin.json', transcript.keys)], { out: (l) => lines.push(l) }), 0);
  assert.equal(JSON.parse(lines[0]).ok, true);
  assert.equal(await runVerify([file, '--pin', tempFile('other.json', makeFixture().keys)], { out: () => {} }), 1);
});

test('buildTranscript embeds only referenced public keys and round-trips through verify', async () => {
  const fixture = makeFixture();
  const publicKey = crypto.createPublicKey({ key: Buffer.from(fixture.keys[0].public_key_spki, 'base64url'), format: 'der', type: 'spki' });
  const endpoints = new Map([
    ['ep_a', { keys: new Map([['key_1', { public_key: publicKey, status: 'active', valid_from: new Date('2026-01-01T00:00:00Z'), valid_until: null }], ['key_unused', { public_key: publicKey }]]) }],
  ]);
  const rows = fixture.entries.map((e) => ({ room_seq: e.room_seq, message_id: e.message_id, canonical_bytes: e.canonical_bytes, envelope: e.envelope }));
  const built = buildTranscript({ roomId: 'room_test', rows, endpoints, now: new Date('2026-11-23T00:00:00Z') });
  assert.equal(built.keys.length, 1);
  assert.equal(built.count, 4);
  assert.equal(built.last_seq, '4');
  const lines = [];
  assert.equal(await runVerify([tempFile('built.json', built)], { out: (l) => lines.push(l) }), 0);
});

test('runRoomExport pages history, writes the file, and the file verifies', async () => {
  const fixture = makeFixture({ count: 3 });
  const publicKey = crypto.createPublicKey({ key: Buffer.from(fixture.keys[0].public_key_spki, 'base64url'), format: 'der', type: 'spki' });
  const repository = {
    async listRoomMessages(roomId, after, limit) {
      assert.equal(roomId, 'room_test');
      return fixture.entries.filter((e) => BigInt(e.room_seq) > after).slice(0, limit);
    },
    async lookupTrustedEndpoint() { return { keys: new Map([['key_1', { public_key: publicKey, status: 'active', valid_from: '2026-01-01T00:00:00.000Z', valid_until: null }]]) }; },
  };
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-export-')), 'transcript.json');
  const lines = [];
  await runRoomExport(['--room', 'room_test', '--out', outFile], { withRepository: (fn) => fn(repository), out: (l) => lines.push(l) });
  assert.match(lines[0], /exported 3 entries and 1 keys/);
  assert.equal(await runVerify([outFile], { out: () => {} }), 0);
  await assert.rejects(runRoomExport(['--out', outFile], { withRepository: (fn) => fn(repository) }), (e) => e.exitCode === 2);
});

test('sigil verify through the real CLI entry, with no relay and no database configured', () => {
  const env = { ...process.env, SIGIL_DATABASE_URL: '', SIGIL_RELAY_URL: 'http://127.0.0.1:1' };
  const good = spawnSync(process.execPath, [cliPath, 'verify', tempFile('good.json', makeFixture())], { encoding: 'utf8', env });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /verified 4 entries/);
  const tampered = makeFixture();
  tampered.entries[1].envelope.body.text = 'forged';
  const bad = spawnSync(process.execPath, [cliPath, 'verify', tempFile('bad.json', tampered)], { encoding: 'utf8', env });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /entry 2 /);
  const usage = spawnSync(process.execPath, [cliPath, 'verify'], { encoding: 'utf8', env });
  assert.equal(usage.status, 2);
});
