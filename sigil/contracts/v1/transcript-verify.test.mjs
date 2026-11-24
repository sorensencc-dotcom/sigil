import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBLEM, formatProblem, verifyTranscript } from './transcript-verify.mjs';
import { makeFixture } from './transcript-fixture.mjs';

const codes = (result) => result.problems.map((p) => p.code);

test('untouched transcript verifies offline', async () => {
  for (const withCanonicalBytes of [true, false]) {
    const result = await verifyTranscript(makeFixture({ withCanonicalBytes }));
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.checked, 4);
    assert.deepEqual(result.problems, []);
  }
});

test('tampered body fails and names the entry number', async () => {
  const transcript = makeFixture();
  transcript.entries[2].envelope.body.text = 'forged';
  const result = await verifyTranscript(transcript);
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].entry, 3);
  assert.equal(result.problems[0].code, PROBLEM.ENVELOPE_MISMATCH);
  assert.match(formatProblem(result.problems[0]), /^entry 3 \(room_seq 3, msg_3\)/);
});

test('tampered body fails with BAD_SIGNATURE when the signed bytes are rebuilt', async () => {
  const transcript = makeFixture({ withCanonicalBytes: false });
  transcript.entries[1].envelope.body.text = 'forged';
  const result = await verifyTranscript(transcript);
  assert.deepEqual(codes(result), [PROBLEM.BAD_SIGNATURE]);
  assert.equal(result.problems[0].entry, 2);
});

test('forged signature value fails', async () => {
  const transcript = makeFixture();
  const other = makeFixture();
  transcript.entries[0].envelope.signature.value = other.entries[0].envelope.signature.value;
  const result = await verifyTranscript(transcript);
  assert.deepEqual(codes(result), [PROBLEM.BAD_SIGNATURE]);
  assert.equal(result.problems[0].entry, 1);
});

test('swapped signing key fails', async () => {
  const transcript = makeFixture();
  transcript.keys = makeFixture().keys;
  const result = await verifyTranscript(transcript);
  assert.equal(result.ok, false);
  assert.ok(codes(result).every((code) => code === PROBLEM.BAD_SIGNATURE));
  assert.equal(result.problems.length, 4);
});

test('missing entry is reported by room_seq', async () => {
  const transcript = makeFixture();
  transcript.entries.splice(1, 1);
  const result = await verifyTranscript(transcript);
  assert.ok(codes(result).includes(PROBLEM.MISSING_ENTRY));
  assert.match(result.problems.find((p) => p.code === PROBLEM.MISSING_ENTRY).message, /room_seq 2 is missing/);
  assert.ok(codes(result).includes(PROBLEM.COUNT_MISMATCH));
});

test('missing tail entry is caught by the declared last_seq', async () => {
  const transcript = makeFixture();
  transcript.entries.pop();
  const result = await verifyTranscript(transcript);
  assert.match(result.problems.find((p) => p.code === PROBLEM.MISSING_ENTRY).message, /room_seq 4 is missing/);
});

test('reordered entries are reported at the out-of-order entry', async () => {
  const transcript = makeFixture();
  [transcript.entries[1], transcript.entries[2]] = [transcript.entries[2], transcript.entries[1]];
  const result = await verifyTranscript(transcript);
  assert.deepEqual(codes(result), [PROBLEM.REORDERED]);
  assert.equal(result.problems[0].entry, 3);
  assert.equal(result.problems[0].room_seq, '2');
});

test('duplicate room_seq and message_id are reported', async () => {
  const transcript = makeFixture();
  transcript.entries[3] = { ...transcript.entries[0] };
  const result = await verifyTranscript(transcript);
  assert.ok(codes(result).includes(PROBLEM.DUPLICATE_SEQ));
  assert.ok(codes(result).includes(PROBLEM.DUPLICATE_MESSAGE));
  assert.ok(codes(result).includes(PROBLEM.MISSING_ENTRY));
});

test('unknown sender key is reported', async () => {
  const transcript = makeFixture();
  transcript.keys = [];
  const result = await verifyTranscript(transcript);
  assert.equal(result.problems.length, 4);
  assert.ok(codes(result).every((code) => code === PROBLEM.MISSING_KEY));
});

test('key valid_until before the signing time is reported', async () => {
  const transcript = makeFixture();
  transcript.keys[0].valid_until = '2026-06-01T00:00:00.000Z';
  const result = await verifyTranscript(transcript);
  assert.ok(codes(result).every((code) => code === PROBLEM.KEY_OUT_OF_WINDOW));
});

test('pinned keys: matching pin passes, different pin fails', async () => {
  const transcript = makeFixture();
  const good = await verifyTranscript(transcript, { pinnedKeys: transcript.keys });
  assert.equal(good.ok, true);
  const bad = await verifyTranscript(transcript, { pinnedKeys: makeFixture().keys });
  assert.equal(bad.ok, false);
  assert.ok(codes(bad).includes(PROBLEM.KEY_MISMATCH));
});

test('malformed documents fail closed without throwing', async () => {
  for (const doc of [null, [], {}, { format: 'sigil.room-transcript', version: 2 }, { format: 'sigil.room-transcript', version: 1, entries: {}, keys: [] }]) {
    const result = await verifyTranscript(doc);
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].code, PROBLEM.MALFORMED_ENTRY);
  }
  const transcript = makeFixture();
  transcript.entries[0].envelope.signature.value = '!!not base64url!!';
  const result = await verifyTranscript(transcript);
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].entry, 1);
});
