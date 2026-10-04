import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

/**
 * In-memory test harness simulating the DLQ Reaper state transitions & archival engine.
 */
function createDlqReaperHarness({ maxRetries = 3, retentionDays = 30 } = {}) {
  const deliveries = new Map();
  const archives = [];

  return {
    deliveries,
    archives,

    seedDelivery({ id, state, attempts = 0, leaseExpiresAt = null, updatedAt = Date.now(), failureCode = null }) {
      deliveries.set(id, {
        delivery_id: id,
        state,
        attempts,
        lease_expires_at: leaseExpiresAt,
        updated_at: updatedAt,
        failure_code: failureCode,
        terminal: failureCode !== null
      });
    },

    reclaimStaleLeases(now = Date.now()) {
      let reclaimed = 0;
      let exhausted = 0;

      for (const [id, record] of deliveries.entries()) {
        if (record.state === 'processing' && record.lease_expires_at !== null && record.lease_expires_at < now) {
          if (record.attempts < maxRetries) {
            record.state = 'queued';
            record.attempts += 1;
            record.lease_expires_at = null;
            record.updated_at = now;
            reclaimed += 1;
          } else {
            record.state = 'processing_failed';
            record.failure_code = 'LEASE_TIMEOUT_EXHAUSTED';
            record.terminal = true;
            record.lease_expires_at = null;
            record.updated_at = now;
            exhausted += 1;
          }
        }
      }

      return { reclaimed, exhausted };
    },

    archiveAndPrune(now = Date.now()) {
      const cutoff = now - (retentionDays * 86400000);
      const toArchive = [];

      for (const [id, record] of deliveries.entries()) {
        if (record.state === 'processing_failed' && record.terminal && record.updated_at <= cutoff) {
          toArchive.push(record);
        }
      }

      if (toArchive.length === 0) {
        return { archivedCount: 0, manifestHash: null, prunedCount: 0 };
      }

      const jsonlPayload = toArchive.map((r) => JSON.stringify(r)).join('\n') + '\n';
      const compressed = zlib.gzipSync(Buffer.from(jsonlPayload, 'utf8'));
      const manifestHash = crypto.createHash('sha256').update(compressed).digest('hex');

      archives.push({
        timestamp: now,
        count: toArchive.length,
        payload: compressed,
        sha256: manifestHash
      });

      for (const record of toArchive) {
        deliveries.delete(record.delivery_id);
      }

      return {
        archivedCount: toArchive.length,
        manifestHash,
        prunedCount: toArchive.length
      };
    }
  };
}

test('reclaims stale lease when attempts are below max_retries', () => {
  const harness = createDlqReaperHarness({ maxRetries: 3 });
  const now = 1_000_000;

  harness.seedDelivery({
    id: 'del_1',
    state: 'processing',
    attempts: 1,
    leaseExpiresAt: now - 5000
  });

  const result = harness.reclaimStaleLeases(now);
  assert.equal(result.reclaimed, 1);
  assert.equal(result.exhausted, 0);

  const delivery = harness.deliveries.get('del_1');
  assert.equal(delivery.state, 'queued');
  assert.equal(delivery.attempts, 2);
  assert.equal(delivery.lease_expires_at, null);
});

test('transitions delivery to processing_failed when retry limit is reached', () => {
  const harness = createDlqReaperHarness({ maxRetries: 3 });
  const now = 1_000_000;

  harness.seedDelivery({
    id: 'del_2',
    state: 'processing',
    attempts: 3,
    leaseExpiresAt: now - 1000
  });

  const result = harness.reclaimStaleLeases(now);
  assert.equal(result.reclaimed, 0);
  assert.equal(result.exhausted, 1);

  const delivery = harness.deliveries.get('del_2');
  assert.equal(delivery.state, 'processing_failed');
  assert.equal(delivery.failure_code, 'LEASE_TIMEOUT_EXHAUSTED');
  assert.equal(delivery.terminal, true);
  assert.equal(delivery.lease_expires_at, null);
});

test('does not touch active leases within valid timeout window', () => {
  const harness = createDlqReaperHarness();
  const now = 1_000_000;

  harness.seedDelivery({
    id: 'del_active',
    state: 'processing',
    attempts: 1,
    leaseExpiresAt: now + 30000
  });

  const result = harness.reclaimStaleLeases(now);
  assert.equal(result.reclaimed, 0);
  assert.equal(result.exhausted, 0);

  const delivery = harness.deliveries.get('del_active');
  assert.equal(delivery.state, 'processing');
});

test('archives and prunes expired dead-letter records with SHA-256 integrity manifest', () => {
  const harness = createDlqReaperHarness({ retentionDays: 30 });
  const now = 100_000_000_000;
  const expiredTime = now - (31 * 86400000);
  const freshFailedTime = now - (5 * 86400000);

  harness.seedDelivery({
    id: 'del_terminal_old',
    state: 'processing_failed',
    attempts: 3,
    failureCode: 'SCHEMA_VALIDATION_ERROR',
    updatedAt: expiredTime
  });

  harness.seedDelivery({
    id: 'del_terminal_recent',
    state: 'processing_failed',
    attempts: 3,
    failureCode: 'INVALID_SIGNATURE',
    updatedAt: freshFailedTime
  });

  const report = harness.archiveAndPrune(now);
  assert.equal(report.archivedCount, 1);
  assert.equal(report.prunedCount, 1);
  assert.ok(typeof report.manifestHash === 'string' && report.manifestHash.length === 64);

  assert.equal(harness.deliveries.has('del_terminal_old'), false);
  assert.equal(harness.deliveries.has('del_terminal_recent'), true);

  assert.equal(harness.archives.length, 1);
  const archive = harness.archives[0];
  assert.equal(archive.sha256, report.manifestHash);

  const decompressed = zlib.gunzipSync(archive.payload).toString('utf8');
  const parsed = JSON.parse(decompressed.trim());
  assert.equal(parsed.delivery_id, 'del_terminal_old');
  assert.equal(parsed.failure_code, 'SCHEMA_VALIDATION_ERROR');
});
