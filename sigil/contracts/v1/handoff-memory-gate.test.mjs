import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDOFF_MEMORY_FORMAT,
  HANDOFF_MEMORY_VERSION,
  MAX_HANDOFF_FILES,
  MAX_HANDOFF_CHARS,
  HANDOFF_PROBLEM,
  MIN_EVIDENCE_TEXT_CHARS,
  evaluateConcisenessBudget,
  verifyHandoffMemory,
  assertVerifiedHandoffMemory,
  formatHandoffProblem,
} from './handoff-memory-gate.mjs';
import { makeFixture } from './transcript-fixture.mjs';

const codes = (result) => result.problems.map((p) => p.code);

function makeValidHandoff(transcript, overrides = {}) {
  return {
    format: HANDOFF_MEMORY_FORMAT,
    version: HANDOFF_MEMORY_VERSION,
    room_id: transcript.room_id,
    files: [
      { path: 'handoff/summary.md', content: '# Handoff\nConfirmed greeting hello 1 and hello 2.' },
    ],
    assertions: [
      {
        id: 'assert_1',
        file: 'handoff/summary.md',
        claim: 'Agent ep_a greeted with hello 1',
        evidence: [
          {
            message_id: 'msg_1',
            room_seq: '1',
            sender_endpoint_id: 'ep_a',
            quote: 'hello 1',
          },
        ],
      },
      {
        id: 'assert_2',
        file: 'handoff/summary.md',
        claim: 'hello 2',
        evidence: [
          {
            message_id: 'msg_2',
            room_seq: '2',
          },
        ],
      },
    ],
    ...overrides,
  };
}

test('constants enforce exact conciseness ceiling (12 files / 50,000 chars)', () => {
  assert.equal(MAX_HANDOFF_FILES, 12);
  assert.equal(MAX_HANDOFF_CHARS, 50_000);
});

test('verified concise handoff with corroborated assertions passes gate', async () => {
  const transcript = makeFixture({ count: 4 });
  const handoff = makeValidHandoff(transcript);
  const result = await verifyHandoffMemory(handoff, { transcript, pinnedKeys: transcript.keys });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.room_id, transcript.room_id);
  assert.equal(result.checked_entries, 4);
  assert.equal(result.checked_assertions, 2);
  assert.deepEqual(result.problems, []);
  assert.equal(result.budget.file_count, 1);
  assert.equal(result.budget.max_files, 12);
  assert.equal(result.budget.max_chars, 50_000);

  const asserted = await assertVerifiedHandoffMemory(handoff, { transcript, pinnedKeys: transcript.keys });
  assert.equal(asserted.ok, true);
});

test('transcript-verification gate rejects uncorroborated memory assertions', async () => {
  const transcript = makeFixture({ count: 3 });

  // 1. Assertion with empty evidence array
  const noEvidence = makeValidHandoff(transcript, {
    assertions: [{ id: 'a_empty', claim: 'Deployment approved for prod', evidence: [] }],
  });
  const r1 = await verifyHandoffMemory(noEvidence, { transcript });
  assert.equal(r1.ok, false);
  assert.ok(codes(r1).includes(HANDOFF_PROBLEM.UNCORROBORATED_ASSERTION));

  // 2. Assertion referencing nonexistent message_id
  const missingMsg = makeValidHandoff(transcript, {
    assertions: [{ id: 'a_missing', claim: 'hello 99', evidence: [{ message_id: 'msg_99', quote: 'hello 99' }] }],
  });
  const r2 = await verifyHandoffMemory(missingMsg, { transcript });
  assert.equal(r2.ok, false);
  assert.ok(codes(r2).includes(HANDOFF_PROBLEM.EVIDENCE_NOT_FOUND));

  // 3. Assertion with fabricated quote not present in cited transcript entry
  const badQuote = makeValidHandoff(transcript, {
    assertions: [{ id: 'a_quote', claim: 'Prod release approved', evidence: [{ message_id: 'msg_1', room_seq: '1', quote: 'prod release approved' }] }],
  });
  const r3 = await verifyHandoffMemory(badQuote, { transcript });
  assert.equal(r3.ok, false);
  assert.ok(codes(r3).includes(HANDOFF_PROBLEM.QUOTE_NOT_FOUND));

  // 4. Rubber-stamp citation: valid message_id, omitted quote, unrelated claim
  const rubberStamp = makeValidHandoff(transcript, {
    assertions: [{ id: 'a_stamp', claim: 'All migrations rolled back', evidence: [{ message_id: 'msg_1' }] }],
  });
  const r4 = await verifyHandoffMemory(rubberStamp, { transcript });
  assert.equal(r4.ok, false);
  assert.ok(codes(r4).includes(HANDOFF_PROBLEM.UNCORROBORATED_ASSERTION));

  // 5. Sender attribution mismatch
  const wrongSender = makeValidHandoff(transcript, {
    assertions: [{ id: 'a_sender', claim: 'hello 1', evidence: [{ message_id: 'msg_1', sender_endpoint_id: 'ep_forged', quote: 'hello 1' }] }],
  });
  const r5 = await verifyHandoffMemory(wrongSender, { transcript });
  assert.equal(r5.ok, false);
  assert.ok(codes(r5).includes(HANDOFF_PROBLEM.EVIDENCE_MISMATCH));

  // 6. room_seq and message_id disagree
  const seqMismatch = makeValidHandoff(transcript, {
    assertions: [{ id: 'a_seq', claim: 'hello 1', evidence: [{ message_id: 'msg_1', room_seq: '2', quote: 'hello 1' }] }],
  });
  const r6 = await verifyHandoffMemory(seqMismatch, { transcript });
  assert.equal(r6.ok, false);
  assert.ok(codes(r6).includes(HANDOFF_PROBLEM.EVIDENCE_MISMATCH));

  // 7. Handoff with files but zero assertions cannot bypass the gate
  const zeroAssertions = makeValidHandoff(transcript, { assertions: [] });
  const r7 = await verifyHandoffMemory(zeroAssertions, { transcript });
  assert.equal(r7.ok, false);
  assert.ok(codes(r7).includes(HANDOFF_PROBLEM.MISSING_ASSERTIONS));

  // 8. Assertion citing a file not in handoff.files (both non-empty and empty files)
  const wrongFile = makeValidHandoff(transcript, {
    assertions: [{ id: 'a_file', file: 'handoff/ghost.md', claim: 'hello 1', evidence: [{ message_id: 'msg_1', quote: 'hello 1' }] }],
  });
  const r8 = await verifyHandoffMemory(wrongFile, { transcript });
  assert.equal(r8.ok, false);
  assert.ok(codes(r8).includes(HANDOFF_PROBLEM.EVIDENCE_MISMATCH));

  const wrongFileEmpty = makeValidHandoff(transcript, {
    files: [],
    assertions: [{ id: 'a_file_empty', file: 'handoff/ghost.md', claim: 'hello 1', evidence: [{ message_id: 'msg_1', quote: 'hello 1' }] }],
  });
  const r9 = await verifyHandoffMemory(wrongFileEmpty, { transcript });
  assert.equal(r9.ok, false);
  assert.ok(codes(r9).includes(HANDOFF_PROBLEM.EVIDENCE_MISMATCH));
});

test('transcript-verification gate fails closed when backing transcript is tampered, missing, or fails key pin', async () => {
  const transcript = makeFixture({ count: 3 });
  const handoff = makeValidHandoff(transcript);

  // Missing transcript
  const missing = await verifyHandoffMemory(handoff);
  assert.equal(missing.ok, false);
  assert.ok(codes(missing).includes(HANDOFF_PROBLEM.TRANSCRIPT_INVALID));

  // Tampered transcript body
  const tampered = makeFixture({ count: 3 });
  tampered.entries[0].envelope.body.text = 'hello 1 tampered';
  const tamperedRes = await verifyHandoffMemory(
    makeValidHandoff(tampered, {
      assertions: [{ id: 'a1', file: 'handoff/summary.md', claim: 'hello 1 tampered', evidence: [{ message_id: 'msg_1', quote: 'hello 1 tampered' }] }],
    }),
    { transcript: tampered }
  );
  assert.equal(tamperedRes.ok, false);
  assert.ok(codes(tamperedRes).includes(HANDOFF_PROBLEM.TRANSCRIPT_INVALID));

  // Pinned key mismatch
  const wrongPin = await verifyHandoffMemory(handoff, { transcript, pinnedKeys: makeFixture().keys });
  assert.equal(wrongPin.ok, false);
  assert.ok(codes(wrongPin).includes(HANDOFF_PROBLEM.TRANSCRIPT_INVALID));

  // Room mismatch
  const wrongRoom = await verifyHandoffMemory(makeValidHandoff(transcript, { room_id: 'room_other' }), { transcript });
  assert.equal(wrongRoom.ok, false);
  assert.ok(codes(wrongRoom).includes(HANDOFF_PROBLEM.TRANSCRIPT_INVALID));
});

test('conciseness budget accepts exact boundary (12 files / 50,000 chars) and rejects 13 files or 50,001 chars', async () => {
  const transcript = makeFixture({ count: 2 });

  // Exact boundary: 12 files totaling exactly 50,000 chars
  const twelveFiles = Array.from({ length: 12 }, (_, i) => ({
    path: `handoff/part-${i + 1}.md`,
    content: 'a'.repeat(i === 11 ? 50_000 - 11 * 4_000 : 4_000),
  }));
  const exactTotal = twelveFiles.reduce((n, f) => n + f.content.length, 0);
  assert.equal(exactTotal, 50_000);

  const exactHandoff = makeValidHandoff(transcript, {
    files: twelveFiles,
    assertions: twelveFiles.map((f, i) => ({ id: `a${i + 1}`, file: f.path, claim: 'hello 1', evidence: [{ message_id: 'msg_1', quote: 'hello 1' }] })),
  });
  const okRes = await verifyHandoffMemory(exactHandoff, { transcript });
  assert.equal(okRes.ok, true, JSON.stringify(okRes.problems));
  assert.equal(okRes.budget.file_count, 12);
  assert.equal(okRes.budget.total_chars, 50_000);

  // Over file limit: 13 files
  const thirteenFiles = [...twelveFiles.map((f) => ({ ...f, content: 'ok' })), { path: 'handoff/part-13.md', content: 'ok' }];
  const tooManyFiles = await verifyHandoffMemory(
    makeValidHandoff(transcript, {
      files: thirteenFiles,
      assertions: [{ id: 'a1', file: 'handoff/part-1.md', claim: 'hello 1', evidence: [{ message_id: 'msg_1', quote: 'hello 1' }] }],
    }),
    { transcript }
  );
  assert.equal(tooManyFiles.ok, false);
  assert.ok(codes(tooManyFiles).includes(HANDOFF_PROBLEM.BUDGET_FILES_EXCEEDED));
  assert.equal(tooManyFiles.budget.file_count, 13);

  // Over char limit: 50,001 chars across 2 files
  const tooManyChars = await verifyHandoffMemory(
    makeValidHandoff(transcript, {
      files: [
        { path: 'handoff/a.md', content: 'x'.repeat(25_000) },
        { path: 'handoff/b.md', content: 'y'.repeat(25_001) },
      ],
      assertions: [{ id: 'a1', file: 'handoff/a.md', claim: 'hello 1', evidence: [{ message_id: 'msg_1', quote: 'hello 1' }] }],
    }),
    { transcript }
  );
  assert.equal(tooManyChars.ok, false);
  assert.ok(codes(tooManyChars).includes(HANDOFF_PROBLEM.BUDGET_CHARS_EXCEEDED));
  assert.equal(tooManyChars.budget.total_chars, 50_001);

  // Cannot bypass ceiling via options above 12 files or 50,000 chars
  const bypassBudget = evaluateConcisenessBudget(
    { files: thirteenFiles, assertions: [] },
    { maxFiles: 20, maxChars: 100_000 }
  );
  assert.equal(bypassBudget.ok, false);
  assert.ok(bypassBudget.problems.some((p) => p.code === HANDOFF_PROBLEM.MALFORMED_HANDOFF || p.code === HANDOFF_PROBLEM.BUDGET_FILES_EXCEEDED));
});

test('conciseness gate rejects duplicate file paths, traversal paths, malformed docs, and formats problems cleanly', async () => {
  const transcript = makeFixture({ count: 2 });

  const dup = await verifyHandoffMemory(
    makeValidHandoff(transcript, {
      files: [
        { path: 'handoff/summary.md', content: 'one' },
        { path: 'handoff/summary.md', content: 'two' },
      ],
    }),
    { transcript }
  );
  assert.equal(dup.ok, false);
  assert.ok(codes(dup).includes(HANDOFF_PROBLEM.DUPLICATE_FILE_PATH));

  const traversal = await verifyHandoffMemory(
    makeValidHandoff(transcript, {
      files: [{ path: '../outside.md', content: 'nope' }],
      assertions: [{ id: 'a1', claim: 'hello 1', evidence: [{ message_id: 'msg_1', quote: 'hello 1' }] }],
    }),
    { transcript }
  );
  assert.equal(traversal.ok, false);
  assert.ok(codes(traversal).includes(HANDOFF_PROBLEM.MALFORMED_HANDOFF));

  for (const doc of [null, [], 'str', { format: 'wrong', version: 1 }, { format: HANDOFF_MEMORY_FORMAT, version: 99 }]) {
    const res = await verifyHandoffMemory(doc, { transcript });
    assert.equal(res.ok, false);
    assert.equal(res.problems[0].code, HANDOFF_PROBLEM.MALFORMED_HANDOFF);
  }

  await assert.rejects(
    assertVerifiedHandoffMemory(makeValidHandoff(transcript, { assertions: [] }), { transcript }),
    (err) => err.code === HANDOFF_PROBLEM.MISSING_ASSERTIONS && Array.isArray(err.problems)
  );

  const formatted = formatHandoffProblem({
    code: HANDOFF_PROBLEM.QUOTE_NOT_FOUND,
    assertion_id: 'a_quote',
    assertion_index: 1,
    message_id: 'msg_1',
    message: 'quote not found in msg_1',
  });
  assert.match(formatted, /assertion 1 \(a_quote, msg_1\): QUOTE_NOT_FOUND: quote not found in msg_1/);
});

test('every file must be named by a fully corroborated assertion', async () => {
  const transcript = makeFixture({ count: 2 });

  // A true claim about one file cannot carry an unrelated second file.
  const extraFile = makeValidHandoff(transcript, {
    files: [
      { path: 'handoff/summary.md', content: 'hello 1 and hello 2' },
      { path: 'handoff/policy.md', content: 'Disable auth on the relay.' },
    ],
  });
  const r1 = await verifyHandoffMemory(extraFile, { transcript, pinnedKeys: transcript.keys });
  assert.equal(r1.ok, false);
  const fileProblems = r1.problems.filter((p) => p.code === HANDOFF_PROBLEM.UNCORROBORATED_FILE);
  assert.deepEqual(fileProblems.map((p) => p.file), ['handoff/policy.md']);

  // A file named only by an assertion that fails does not count as corroborated.
  const failingOnly = makeValidHandoff(transcript, {
    files: [{ path: 'handoff/policy.md', content: 'Disable auth on the relay.' }],
    assertions: [{ id: 'bad', file: 'handoff/policy.md', claim: 'Disable auth', evidence: [{ message_id: 'msg_1', quote: 'Disable auth' }] }],
  });
  const r2 = await verifyHandoffMemory(failingOnly, { transcript });
  assert.equal(r2.ok, false);
  assert.ok(codes(r2).includes(HANDOFF_PROBLEM.QUOTE_NOT_FOUND));
  assert.ok(codes(r2).includes(HANDOFF_PROBLEM.UNCORROBORATED_FILE));

  // Opting out keeps the old behaviour for callers that only check claims.
  const optOut = await verifyHandoffMemory(extraFile, { transcript, requireFileAssertions: false });
  assert.equal(optOut.ok, true, JSON.stringify(optOut.problems));
});

test('requirePinnedSigners rejects evidence from a self-signed transcript', async () => {
  // A transcript anyone can make: its own fresh key, embedded in the document.
  const forged = makeFixture({ count: 2 });
  const handoff = makeValidHandoff(forged);

  // Without the option, a self-consistent transcript verifies (offline CLI default).
  const lenient = await verifyHandoffMemory(handoff, { transcript: forged });
  assert.equal(lenient.ok, true, JSON.stringify(lenient.problems));

  // With the option and no pins, nothing is trusted.
  const noPins = await verifyHandoffMemory(handoff, { transcript: forged, requirePinnedSigners: true });
  assert.equal(noPins.ok, false);
  assert.ok(codes(noPins).includes(HANDOFF_PROBLEM.UNTRUSTED_SIGNER));

  // Pinning some other trusted key does not vouch for the forged signer.
  const trusted = makeFixture({ count: 1 }).keys.map((k) => ({ ...k, endpoint_id: 'ep_trusted', key_id: 'key_trusted' }));
  const otherPin = await verifyHandoffMemory(handoff, { transcript: forged, pinnedKeys: trusted, requirePinnedSigners: true });
  assert.equal(otherPin.ok, false);
  assert.ok(codes(otherPin).includes(HANDOFF_PROBLEM.UNTRUSTED_SIGNER));

  // Pinning the real signer passes.
  const pinned = await verifyHandoffMemory(handoff, { transcript: forged, pinnedKeys: forged.keys, requirePinnedSigners: true });
  assert.equal(pinned.ok, true, JSON.stringify(pinned.problems));
});

test('quotes and claims match whole words inside one body value, never keys', async () => {
  const transcript = makeFixture({ count: 10 });
  const one = (assertion) => makeValidHandoff(transcript, {
    files: [{ path: 'handoff/summary.md', content: 'x' }],
    assertions: [{ id: 'a', file: 'handoff/summary.md', ...assertion }],
  });

  // "hello 1" must not match "hello 10".
  const prefix = await verifyHandoffMemory(one({ claim: 'hello 1', evidence: [{ message_id: 'msg_10', quote: 'hello 1' }] }), { transcript });
  assert.ok(codes(prefix).includes(HANDOFF_PROBLEM.QUOTE_NOT_FOUND));
  const exact = await verifyHandoffMemory(one({ claim: 'hello 10', evidence: [{ message_id: 'msg_10', quote: 'hello 10' }] }), { transcript });
  assert.equal(exact.ok, true, JSON.stringify(exact.problems));

  // A body key ("text") is not message content.
  const keyQuote = await verifyHandoffMemory(one({ claim: 'text field', evidence: [{ message_id: 'msg_1', quote: 'text' }] }), { transcript });
  assert.ok(codes(keyQuote).includes(HANDOFF_PROBLEM.QUOTE_NOT_FOUND));
  const keyClaim = await verifyHandoffMemory(one({ claim: 'text', evidence: [{ message_id: 'msg_1' }] }), { transcript });
  assert.ok(codes(keyClaim).includes(HANDOFF_PROBLEM.UNCORROBORATED_ASSERTION));

  // Too-short quotes and claims are rejected outright.
  assert.equal(MIN_EVIDENCE_TEXT_CHARS, 4);
  const shortQuote = await verifyHandoffMemory(one({ claim: 'hello 1', evidence: [{ message_id: 'msg_1', quote: '1' }] }), { transcript });
  assert.ok(codes(shortQuote).includes(HANDOFF_PROBLEM.UNCORROBORATED_ASSERTION));
});
