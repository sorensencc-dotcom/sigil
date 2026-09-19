import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { quarantineAttachment } from './quarantine.mjs';
import { createLocalQuarantineStorage } from './local-quarantine-storage.mjs';
import { purgeExpiredQuarantine } from './quarantine-retention.mjs';

async function fixtureRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sigil-agentmail-quarantine-'));
}

test('local quarantine encrypts content and supports authenticated reads', async () => {
  const rootDir = await fixtureRoot();
  const storage = createLocalQuarantineStorage({ rootDir, key: crypto.randomBytes(32), clock: () => new Date('2026-09-14T12:00:00Z') });
  const result = await quarantineAttachment([Buffer.from('synthetic private attachment')], { mediaType: 'text/plain', maxBytes: 100 }, storage);
  const id = result.reference.split('/').at(-1);
  const stored = await fs.readFile(path.join(rootDir, `${id}.bin`));
  assert.equal(stored.includes(Buffer.from('synthetic private attachment')), false);
  assert.deepEqual(await storage.read(result.reference), Buffer.from('synthetic private attachment'));
});

test('retention purge deletes expired objects, preserves legal holds, and audits counts without content', async () => {
  const rootDir = await fixtureRoot();
  const storage = createLocalQuarantineStorage({ rootDir, key: Buffer.alloc(32, 7), clock: () => new Date('2026-09-14T12:00:00Z') });
  const expired = await quarantineAttachment('expired', { mediaType: 'text/plain', expiresAt: '2026-09-13T00:00:00Z' }, storage);
  const held = await quarantineAttachment('held', { mediaType: 'text/plain', expiresAt: '2026-09-13T00:00:00Z', legalHold: true }, storage);
  const audits = [];
  const result = await purgeExpiredQuarantine(storage, { now: new Date('2026-09-14T00:00:00Z'), audit: async (event) => audits.push(event) });
  assert.deepEqual(result, { status: 'COMPLETE', cutoff: '2026-09-14T00:00:00.000Z', considered: 2, deleted: 1, held: 1, failed: 0 });
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0], { eventType: 'agentmail.quarantine.purged', outcome: 'complete', cutoff: '2026-09-14T00:00:00.000Z', considered: 2, deleted: 1, held: 1, failed: 0 });
  await assert.rejects(storage.read(expired.reference), { code: 'QUARANTINE_OBJECT_NOT_FOUND' });
  assert.deepEqual(await storage.read(held.reference), Buffer.from('held'));
  assert.equal(JSON.stringify(audits).includes('expired'), false);
});

test('purge refuses to run without an audit sink', async () => {
  const storage = { async listExpired() { return []; }, async delete() {} };
  await assert.rejects(purgeExpiredQuarantine(storage), { code: 'QUARANTINE_AUDIT_UNAVAILABLE' });
});

test('legal hold cannot be cleared through retention updates or direct deletion', async () => {
  const rootDir = await fixtureRoot();
  const storage = createLocalQuarantineStorage({ rootDir, key: Buffer.alloc(32, 7), clock: () => new Date('2026-09-14T12:00:00Z') });
  const writer = await storage.createWriter({ mediaType: 'text/plain', legalHold: true });
  await writer.write('synthetic');
  const reference = await writer.finalize();
  await assert.rejects(storage.setRetention(reference, { legalHold: false }), { code: 'QUARANTINE_LEGAL_HOLD' });
  await assert.rejects(storage.delete(reference), { code: 'QUARANTINE_LEGAL_HOLD' });
  assert.equal((await storage.read(reference)).toString(), 'synthetic');
});
