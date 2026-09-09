const BACKOFF_MS = [60_000, 300_000, 1_800_000];
const MAX_ATTEMPTS = 4;

function counts() {
  return { claimed: 0, fulfilled: 0, requeued: 0, deadLettered: 0, resets: 0, pushed: 0 };
}

function jobContext(row) {
  return {
    conversation_id: row.payload.conversation_id,
    target_sender_endpoint_id: row.payload.target_sender_endpoint_id,
    requester_endpoint_id: row.payload.requester_endpoint_id,
    begin_seq: row.payload.begin_seq,
    end_seq: row.payload.end_seq,
    job_type: 'resend',
    attempt_count: row.attemptCount,
  };
}

async function finalize(repository, row, state, patch) {
  return repository.withTransaction((client) =>
    repository.finalizeRelayJob('resend', row.id, row.claimToken, state, patch, client));
}

async function requeueOrDeadLetter({ repository, row, now, reasonCode, logger, metrics, result }) {
  const nextAttemptCount = row.attemptCount + 1;
  const context = jobContext(row);
  if (nextAttemptCount >= MAX_ATTEMPTS) {
    const finalized = await finalize(repository, row, 'dead_letter', { attemptCount: nextAttemptCount, reasonCode });
    if (!finalized.updated) return;
    result.deadLettered += 1;
    await repository.recordAuditEvent({
      eventType: 'session.resend_dead_letter', subjectId: row.id,
      endpointId: row.payload.requester_endpoint_id, conversationId: row.payload.conversation_id,
      outcome: 'rejected', reason: reasonCode,
      payload: { ...context, attempt_count: nextAttemptCount }, now,
    }).catch(() => {});
    metrics?.increment?.('sigil_relay_jobs_dead_letter_total', 1, { job_type: 'resend', reason: reasonCode });
    logger?.error?.({ event: 'session.resend_dead_letter', ...context, attempt_count: nextAttemptCount, reason: reasonCode });
    return;
  }
  const nextAttemptAt = new Date(now.getTime() + BACKOFF_MS[nextAttemptCount - 1]);
  const finalized = await finalize(repository, row, 'pending', { attemptCount: nextAttemptCount, nextAttemptAt, reasonCode });
  if (!finalized.updated) return;
  result.requeued += 1;
  logger?.warn?.({ event: 'session.resend_requeued', ...context, attempt_count: nextAttemptCount, reason: reasonCode });
}

function orderedRows(rows) {
  return [...rows].sort((left, right) => {
    const a = BigInt(left.streamSeq);
    const b = BigInt(right.streamSeq);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export async function runResendWorkerPass({ repository, stream, now = new Date(), limit = 10, leaseSeconds = 30, metrics, logger } = {}) {
  const result = counts();
  if (metrics && repository.relayJobHealth) {
    const health = await repository.relayJobHealth('resend', now);
    metrics.set('sigil_relay_jobs_depth', health.depth, { job_type: 'resend' });
    metrics.set('sigil_relay_jobs_oldest_age_seconds', health.oldestAgeSeconds, { job_type: 'resend' });
  }
  const claimed = await repository.claimDueRelayJobs('resend', now, limit, leaseSeconds);
  result.claimed = claimed.length;

  for (const row of claimed) {
    const context = jobContext(row);
    try {
      const available = orderedRows(await repository.listResendEnvelopes(
        row.payload.target_sender_endpoint_id,
        row.payload.conversation_id,
        row.payload.begin_seq,
        row.payload.end_seq,
        now,
      ));
      let expected = row.payload.begin_seq;
      let pushCount = 0;
      let resetCount = 0;
      let streamUnavailable = false;

      for (const item of available) {
        const streamSeq = Number(item.streamSeq);
        if (!Number.isSafeInteger(streamSeq) || streamSeq < expected || streamSeq > row.payload.end_seq) continue;
        if (expected < streamSeq) {
          const reset = {
            conversation_id: row.payload.conversation_id,
            target_sender_endpoint_id: row.payload.target_sender_endpoint_id,
            gap_fill_from: expected,
            new_seq: streamSeq,
            reason: 'expired',
          };
          if (stream?.notifySequenceReset?.(row.payload.requester_endpoint_id, reset) !== true) {
            streamUnavailable = true;
            break;
          }
          resetCount += 1;
          logger?.warn?.({ event: 'session.sequence_reset', ...context, ...reset });
        }
        if (stream?.notifyResend?.(row.payload.requester_endpoint_id, { streamSeq: item.streamSeq, envelope: item.envelope }) !== true) {
          streamUnavailable = true;
          break;
        }
        pushCount += 1;
        logger?.debug?.({ event: 'session.resend_push', ...context, stream_seq: String(item.streamSeq) });
        expected = streamSeq + 1;
      }
      if (!streamUnavailable && expected <= row.payload.end_seq) {
        const reset = {
          conversation_id: row.payload.conversation_id,
          target_sender_endpoint_id: row.payload.target_sender_endpoint_id,
          gap_fill_from: expected,
          new_seq: row.payload.end_seq + 1,
          reason: 'expired',
        };
        if (stream?.notifySequenceReset?.(row.payload.requester_endpoint_id, reset) !== true) streamUnavailable = true;
        else {
          resetCount += 1;
          logger?.warn?.({ event: 'session.sequence_reset', ...context, ...reset });
        }
      }
      if (streamUnavailable) {
        await requeueOrDeadLetter({ repository, row, now, reasonCode: 'REQUESTER_STREAM_UNAVAILABLE', logger, metrics, result });
        continue;
      }

      const finalized = await finalize(repository, row, 'done', { attemptCount: row.attemptCount, reasonCode: null });
      if (!finalized.updated) continue;
      result.fulfilled += 1;
      result.pushed += pushCount;
      result.resets += resetCount;
      await repository.recordAuditEvent({
        eventType: 'session.resend_fulfilled', subjectId: row.id,
        endpointId: row.payload.requester_endpoint_id, conversationId: row.payload.conversation_id,
        outcome: 'fulfilled', payload: { ...context, pushed: pushCount, resets: resetCount }, now,
      }).catch(() => {});
      metrics?.increment?.('sigil_resend_fulfilled_total', 1, { conversation_kind: 'direct' });
      if (resetCount) metrics?.increment?.('sigil_sequence_reset_total', resetCount, { reason: 'expired' });
      const ageSeconds = Math.max(0, (now.getTime() - Date.parse(row.createdAt)) / 1000);
      metrics?.observe?.('sigil_resend_latency_seconds', ageSeconds, { conversation_kind: 'direct' });
      logger?.info?.({ event: 'session.resend_fulfilled', ...context, pushed: pushCount, resets: resetCount });
    } catch (error) {
      await requeueOrDeadLetter({ repository, row, now, reasonCode: error?.code ?? 'RESEND_WORKER_FAILED', logger, metrics, result });
    }
  }
  return result;
}

export function startResendWorker({ repository, stream, intervalMs = 60_000, metrics, logger } = {}) {
  return setInterval(async () => {
    try {
      await runResendWorkerPass({ repository, stream, metrics, logger });
    } catch (error) {
      (logger ?? console).error(`sigil: resend worker pass failed: ${error?.message ?? error}`);
    }
  }, intervalMs).unref();
}
