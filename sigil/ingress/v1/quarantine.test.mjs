import test from 'node:test';
import assert from 'node:assert/strict';
import { quarantineAttachment } from './quarantine.mjs';

function fakeStorage() {
  const writes = [];
  return {
    writes,
    async createWriter() {
      return {
        async write(chunk) { writes.push(Buffer.from(chunk)); },
        async finalize() { return 'quarantine://synthetic/attachment-1'; },
        async abort() { writes.length = 0; },
      };
    },
  };
}

test('quarantineAttachment streams, hashes, and returns only a reference', async () => {
  const storage = fakeStorage();
  const result = await quarantineAttachment((async function* () {
    yield Buffer.from('synthetic ');
    yield Buffer.from('document');
  })(), { mediaType: 'text/plain', filename: 'synthetic.txt', maxBytes: 100 }, storage);
  assert.deepEqual(result, {
    reference: 'quarantine://synthetic/attachment-1',
    sha256: 'e2639d66c3a747f39489b5842b889a33484ac08b25ed74b71655c569efd93ab7',
    mediaType: 'text/plain',
    byteLength: 18,
  });
  assert.equal(Buffer.concat(storage.writes).toString(), 'synthetic document');
  assert.equal('content' in result, false);
});

test('quarantineAttachment rejects oversized and malformed streams', async () => {
  const storage = fakeStorage();
  await assert.rejects(
    quarantineAttachment([Buffer.from('12345')], { mediaType: 'text/plain', maxBytes: 4 }, storage),
    { code: 'ATTACHMENT_TOO_LARGE' },
  );
  await assert.rejects(
    quarantineAttachment(null, { mediaType: 'text/plain' }, storage),
    { code: 'INVALID_ATTACHMENT' },
  );
});

test('quarantineAttachment aborts storage on write failure without exposing content', async () => {
  let aborted = false;
  const storage = {
    async createWriter() { return { async write() { throw new Error('synthetic storage failure'); }, async finalize() { return 'quarantine://synthetic/never'; }, async abort() { aborted = true; } }; },
  };
  await assert.rejects(quarantineAttachment([Buffer.from('secret synthetic')], { mediaType: 'text/plain' }, storage), { code: 'QUARANTINE_FAILED' });
  assert.equal(aborted, true);
});
