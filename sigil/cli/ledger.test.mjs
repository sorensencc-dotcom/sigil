import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { appendInboxLedger, readInboxLedger } from './ledger.mjs';

test('appendInboxLedger appends records and readInboxLedger reads them back', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sigil-ledger-test-'));
  const ledgerPath = path.join(tmpDir, 'inbox.jsonl');

  const rec1 = { received_at: '2026-08-16T00:00:00.000Z', delivery_id: 'd1', envelope: { body: { text: 'one' } } };
  const rec2 = { received_at: '2026-08-16T00:01:00.000Z', delivery_id: 'd2', envelope: { body: { text: 'two' } } };

  await appendInboxLedger(ledgerPath, rec1);
  await appendInboxLedger(ledgerPath, rec2);

  const records = await readInboxLedger(ledgerPath);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], rec1);
  assert.deepEqual(records[1], rec2);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('readInboxLedger returns empty array for non-existent file', async () => {
  const nonExistent = path.join(os.tmpdir(), 'non-existent-ledger.jsonl');
  const records = await readInboxLedger(nonExistent);
  assert.deepEqual(records, []);
});
