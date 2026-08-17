import test from 'node:test';
import assert from 'node:assert/strict';
import { writeRejectionAudit } from './rejection-audit.mjs';

function repositoryThatFails(times) {
  let calls = 0;
  return {
    calls: 0,
    async recordAuditEvent() {
      calls += 1;
      this.calls = calls;
      if (calls <= times) throw new Error('transient');
      return { event_id: 'audit_ok' };
    }
  };
}

test('writes on the first attempt when the repository succeeds immediately', async () => {
  const repository = repositoryThatFails(0);
  const result = await writeRejectionAudit({ repository, event: { eventType: 'envelope.rejected' }, delayMs: 0 });
  assert.deepEqual(result, { written: true, degraded: false });
  assert.equal(repository.calls, 1);
});

test('retries exactly once after a transient failure, then succeeds', async () => {
  const repository = repositoryThatFails(1);
  const result = await writeRejectionAudit({ repository, event: { eventType: 'envelope.rejected' }, delayMs: 0 });
  assert.deepEqual(result, { written: true, degraded: false });
  assert.equal(repository.calls, 2);
});

test('falls back to the log after the retry also fails, without throwing', async () => {
  const repository = repositoryThatFails(5);
  const fallbackLog = { entries: [], async append(entry) { this.entries.push(entry); } };
  const result = await writeRejectionAudit({ repository, event: { eventType: 'envelope.rejected', subjectId: 'msg_1' }, fallbackLog, delayMs: 0 });
  assert.deepEqual(result, { written: false, degraded: true });
  assert.equal(repository.calls, 2);
  assert.equal(fallbackLog.entries.length, 1);
  assert.equal(fallbackLog.entries[0].eventType, 'envelope.rejected');
});

test('a fallback-log failure is swallowed, never thrown to the caller', async () => {
  const repository = repositoryThatFails(5);
  const fallbackLog = { async append() { throw new Error('disk full'); } };
  await assert.doesNotReject(() => writeRejectionAudit({ repository, event: { eventType: 'x' }, fallbackLog, delayMs: 0 }));
});
