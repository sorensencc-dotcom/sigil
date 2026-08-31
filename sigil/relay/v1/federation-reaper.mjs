// sigil/relay/v1/federation-reaper.mjs
//
// Drains `federation_outbox` for a `--federation-mode queue` relay. Each pass
// claims a batch of due rows in one committed transaction, then -- outside that
// transaction -- forwards every claimed row to its pinned peer relay and
// finalizes it with an ownership-guarded write (retry/backoff/dead-letter).
//
// The claim commits BEFORE any HTTP so a slow or hung peer never holds a
// database transaction open. Every `finalizeFederationForward` is guarded by
// the row's claim token: `{ updated: false }` means another reaper stole the
// lease, so the result is discarded silently (no audit, no counter bump).

import { buildForwardRequest, signForwardRequest, postForward } from './federation-router.mjs';

// Backoff before the Nth retry (index = attemptCount - 1): 1 min, 5 min, 30 min.
const BACKOFF_MS = [60_000, 300_000, 1_800_000];
const MAX_ATTEMPTS = 3;

function finalize(repository, row, state, patch) {
  return repository.withTransaction((client) =>
    repository.finalizeFederationForward(row.id, row.claimToken, state, patch, client));
}

export async function runFederationReaperPass({
  repository,
  identity,
  originDomain,
  now = new Date(),
  fetchImpl,
  postForwardImpl,
  limit = 500,
  leaseSeconds = 300,
} = {}) {
  // Step 1: claim + commit. Nothing below runs inside this transaction.
  const rows = await repository.withTransaction((client) =>
    repository.claimDueFederationForwards(now, limit, leaseSeconds, client));

  const counts = { claimed: rows.length, forwarded: 0, rejected: 0, failed: 0, deadLettered: 0 };
  const doPost = postForwardImpl ?? postForward;
  const nowMs = now.getTime();

  for (const row of rows) {
    const auditBase = {
      subjectId: row.messageId,
      endpointId: row.envelope?.sender?.endpoint_id,
      now,
    };

    // Expired envelope: terminal dead-letter, no forward attempted.
    if (Date.parse(row.envelope?.expires_at) <= nowMs) {
      const { updated } = await finalize(repository, row, 'dead_letter', {
        attemptCount: row.attemptCount,
        reasonCode: 'MESSAGE_EXPIRED',
      });
      if (updated) {
        counts.deadLettered += 1;
        await repository.recordAuditEvent({
          ...auditBase,
          eventType: 'federation.dead_letter',
          outcome: 'rejected',
          reason: 'MESSAGE_EXPIRED',
          payload: { reason_code: 'MESSAGE_EXPIRED' },
        });
      }
      continue;
    }

    const { canonicalBytes } = buildForwardRequest(row.envelope, {
      originDomain,
      senderKey: row.senderKey,
      senderOwnerId: row.senderOwnerId,
      now,
    });
    const signed = signForwardRequest(canonicalBytes, identity);

    let outcome;
    let transportFailed = false;
    let transportReason = 'FORWARD_TRANSPORT_FAILED';
    try {
      const peer = await repository.getPeerByDomain(row.recipientDomain);
      if (!peer) {
        // Peer got unpinned since enqueue -- treat as a transient transport
        // failure and back off, rather than calling postForward with an
        // undefined relayUrl.
        transportFailed = true;
        transportReason = 'PEER_NOT_PINNED';
      } else {
        outcome = await doPost({ relayUrl: peer.relayUrl }, canonicalBytes, signed, { fetchImpl });
      }
    } catch (error) {
      if (error && error.code === 'FORWARD_TRANSPORT_FAILED') {
        transportFailed = true;
      } else {
        throw error;
      }
    }

    if (transportFailed) {
      const nextAttemptCount = row.attemptCount + 1;
      if (nextAttemptCount >= MAX_ATTEMPTS) {
        const { updated } = await finalize(repository, row, 'dead_letter', {
          attemptCount: nextAttemptCount,
          reasonCode: transportReason,
        });
        if (updated) {
          counts.deadLettered += 1;
          await repository.recordAuditEvent({
            ...auditBase,
            eventType: 'federation.dead_letter',
            outcome: 'rejected',
            reason: transportReason,
            payload: { reason_code: transportReason, attempt_count: nextAttemptCount },
          });
        }
      } else {
        const nextAttemptAt = new Date(nowMs + BACKOFF_MS[nextAttemptCount - 1]);
        const { updated } = await finalize(repository, row, 'pending', {
          attemptCount: nextAttemptCount,
          nextAttemptAt,
          reasonCode: transportReason,
        });
        if (updated) {
          counts.failed += 1;
          await repository.recordAuditEvent({
            ...auditBase,
            eventType: 'federation.forward_unavailable',
            outcome: 'rejected',
            reason: transportReason,
            payload: { reason_code: transportReason, attempt_count: nextAttemptCount },
          });
        }
      }
      continue;
    }

    if (outcome.ok) {
      const { updated } = await finalize(repository, row, 'forwarded', {
        attemptCount: row.attemptCount,
        reasonCode: null,
      });
      if (updated) {
        counts.forwarded += 1;
        await repository.recordAuditEvent({
          ...auditBase,
          eventType: 'federation.forwarded',
          outcome: 'forwarded',
          reason: null,
          payload: { peer_status: outcome.status ?? null },
        });
      }
      continue;
    }

    // 4xx from the peer: terminal rejection.
    const peerCode = outcome.peerCode ?? null;
    const { updated } = await finalize(repository, row, 'forward_rejected', {
      attemptCount: row.attemptCount,
      reasonCode: peerCode,
    });
    if (updated) {
      counts.rejected += 1;
      await repository.recordAuditEvent({
        ...auditBase,
        eventType: 'federation.forward_rejected',
        outcome: 'rejected',
        reason: peerCode,
        payload: { peer_code: peerCode, peer_status: outcome.status ?? null },
      });
    }
  }

  return counts;
}

// Interval driver, mirroring `startOidcIssuerAllowlistPolling` in sigil.mjs.
// Returns the already-unref()'d handle so a test can clearInterval it. A thrown
// pass is logged and the interval keeps ticking.
export function startFederationReaper({ repository, identity, originDomain, intervalMs = 60_000, fetchImpl }) {
  return setInterval(async () => {
    try {
      await runFederationReaperPass({ repository, identity, originDomain, fetchImpl });
    } catch (error) {
      console.error(`sigil: federation reaper pass failed: ${error.message}`);
    }
  }, intervalMs).unref();
}
