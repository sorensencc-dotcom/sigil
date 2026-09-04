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
//
// A claimed row carries a `kind`: `envelope` (the default) takes the
// buildForwardRequest / postForward path unchanged; every `directory_*` kind
// sends its `directoryPayload` verbatim as the wire body (it was fixed at
// enqueue time), re-canonicalized only for the Ed25519 signing input, to the
// matching `/v1/federation/directory/*` path via `postDirectory`.

import { buildForwardRequest, signForwardRequest, postForward } from './federation-router.mjs';
import { canonicalJsonBytes } from './jcs.mjs';
import { signRelayRequest, postDirectory } from './federation-directory-client.mjs';

// Backoff before the Nth retry (index = attemptCount - 1): 1 min, 5 min, 30 min.
// MAX_ATTEMPTS is 4 so all three backoffs are walked: transport failures 1-3
// re-queue with BACKOFF_MS[0..2] (1m / 5m / 30m) and the FOURTH failure
// dead-letters. The dead-letter guard below (nextAttemptCount >= MAX_ATTEMPTS)
// only fires at nextAttemptCount === 4, so BACKOFF_MS is never indexed past 2.
const BACKOFF_MS = [60_000, 300_000, 1_800_000];
const MAX_ATTEMPTS = 4;

const PATH_BY_KIND = {
  directory_redemption: '/v1/federation/directory/redemptions',
  directory_confirmation: '/v1/federation/directory/confirmations',
  directory_revocation: '/v1/federation/directory/revocations',
};

function finalize(repository, row, state, patch) {
  return repository.withTransaction((client) =>
    repository.finalizeFederationForward(row.id, row.claimToken, state, patch, client));
}

// Shared transport-failure / 2xx / 4xx tail for both the `envelope` and the
// `directory_*` branches: finalize the row (ownership-guarded), bump the matching
// counter, and record the matching audit event. Returns the terminal (or
// re-queued) state plus the reason code that was written and whether the
// ownership-guarded finalize actually landed, so a caller can chain
// kind-specific follow-up work (the directory_redemption link write / expire).
async function settleForward({ repository, row, auditBase, counts, nowMs, outcome, transportFailed, transportReason }) {
  const kindPayload = row.kind && row.kind !== 'envelope' ? { kind: row.kind } : {};

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
          payload: { reason_code: transportReason, attempt_count: nextAttemptCount, ...kindPayload },
        }).catch(() => {});
      }
      return { state: 'dead_letter', reasonCode: transportReason, updated };
    }
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
        payload: { reason_code: transportReason, attempt_count: nextAttemptCount, ...kindPayload },
      }).catch(() => {});
    }
    return { state: 'pending', reasonCode: transportReason, updated };
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
        payload: { peer_status: outcome.status ?? null, ...kindPayload },
      }).catch(() => {});
    }
    return { state: 'forwarded', reasonCode: null, updated };
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
      payload: { peer_code: peerCode, peer_status: outcome.status ?? null, ...kindPayload },
    }).catch(() => {});
  }
  return { state: 'forward_rejected', reasonCode: peerCode, updated };
}

// directory_redemption only: on a 2xx from the redeemer relay, mirror the
// issuer relay's `federation_directory_links` row locally from the 202 body,
// idempotently. The sync `redeem` POST (Task 12) usually wrote this row already;
// a prior reaper pass may have too. A non-compliant peer that omits `issuer`
// leaves the row absent -- not an error (see task-11 report concern).
async function writeRedeemerLink({ repository, row, outcome, now }) {
  const issuer = outcome && outcome.body && outcome.body.issuer;
  if (!issuer || !issuer.owner_id || !issuer.endpoint_id) return;
  await repository.withTransaction(async (client) => {
    const existing = await repository.getFederationDirectoryLinkByRef(row.directoryPayload.link_ref, client);
    if (existing) return;
    try {
      await repository.createFederationDirectoryLink({
        linkRef: row.directoryPayload.link_ref,
        localOwnerId: row.directoryPayload.redeemer.owner_id,
        localEndpointId: row.directoryPayload.redeemer.endpoint_id,
        remoteOwnerId: issuer.owner_id,
        remoteEndpointId: issuer.endpoint_id,
        remoteDomain: row.recipientDomain,
        role: 'redeemer',
        status: 'pending',
        localConfirmedAt: now,
        remoteConfirmedAt: null,
        sourceInviteId: null,
        peerDomain: row.recipientDomain,
      }, client);
    } catch (error) {
      // A concurrent writer (sync redeem, or another reaper) won the race.
      if (!error || error.code !== 'FEDERATION_LINK_EXISTS') throw error;
    }
  });
}

async function dispatchDirectoryRow({ repository, row, identity, now, nowMs, fetchImpl, doPostDir, counts }) {
  const auditBase = { subjectId: row.messageId, endpointId: undefined, now };
  const path = PATH_BY_KIND[row.kind];

  // Sign the payload verbatim -- never re-run build*Request for a directory row.
  // A missing path or an uncanonicalizable payload is a poison row: dead-letter
  // it (ownership-guarded) rather than aborting the whole pass.
  let canonicalBytes;
  let signed;
  try {
    if (!path) throw new Error(`federation reaper: unknown directory kind ${row.kind}`);
    canonicalBytes = canonicalJsonBytes(row.directoryPayload);
    signed = signRelayRequest(canonicalBytes, identity);
  } catch {
    const { updated } = await finalize(repository, row, 'dead_letter', {
      attemptCount: row.attemptCount,
      reasonCode: 'FORWARD_BUILD_FAILED',
    });
    if (updated) {
      counts.deadLettered += 1;
      await repository.recordAuditEvent({
        ...auditBase,
        eventType: 'federation.dead_letter',
        outcome: 'rejected',
        reason: 'FORWARD_BUILD_FAILED',
        payload: { reason_code: 'FORWARD_BUILD_FAILED', kind: row.kind },
      }).catch(() => {});
    }
    return;
  }

  let outcome;
  let transportFailed = false;
  let transportReason = 'FORWARD_TRANSPORT_FAILED';
  try {
    const peer = await repository.getPeerByDomain(row.recipientDomain);
    if (!peer) {
      transportFailed = true;
      transportReason = 'PEER_NOT_PINNED';
    } else {
      outcome = await doPostDir({ relayUrl: peer.relayUrl }, path, canonicalBytes, signed, { fetchImpl });
    }
  } catch (error) {
    if (error && error.code === 'FORWARD_TRANSPORT_FAILED') transportFailed = true;
    else throw error;
  }

  const result = await settleForward({
    repository, row, auditBase, counts, nowMs, outcome, transportFailed, transportReason,
  });

  if (row.kind !== 'directory_redemption' || !result.updated) return;
  if (result.state === 'forwarded') {
    await writeRedeemerLink({ repository, row, outcome, now });
  } else if (result.state === 'forward_rejected' || result.state === 'dead_letter') {
    const reason = row.lastReasonCode ?? result.reasonCode ?? result.state;
    await repository.withTransaction((client) =>
      repository.markFederationDirectoryLinkExpired(row.directoryPayload.link_ref, reason, now, client));
  }
}

export async function runFederationReaperPass({
  repository,
  identity,
  originDomain,
  now = new Date(),
  fetchImpl,
  postForwardImpl,
  postDirectoryImpl,
  limit = 500,
  leaseSeconds = 300,
} = {}) {
  // Step 1: claim + commit. Nothing below runs inside this transaction.
  const rows = await repository.withTransaction((client) =>
    repository.claimDueFederationForwards(now, limit, leaseSeconds, client));

  const counts = { claimed: rows.length, forwarded: 0, rejected: 0, failed: 0, deadLettered: 0 };
  const doPost = postForwardImpl ?? postForward;
  const doPostDir = postDirectoryImpl ?? postDirectory;
  const nowMs = now.getTime();

  for (const row of rows) {
    // `directory_*` rows: sign the stored wire body and POST it to the matching
    // directory path; envelope rows fall through to the unchanged path below.
    if (row.kind && row.kind !== 'envelope') {
      await dispatchDirectoryRow({ repository, row, identity, now, nowMs, fetchImpl, doPostDir, counts });
      continue;
    }

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
        }).catch(() => {});
      }
      continue;
    }

    // A malformed stored envelope or a bad identity key makes buildForwardRequest
    // / signForwardRequest throw. That throw precedes every finalize below, so an
    // unguarded one aborts the whole pass and wedges every row behind this one.
    // Route the poison row to dead_letter (ownership-guarded) and move on.
    let canonicalBytes;
    let signed;
    try {
      ({ canonicalBytes } = buildForwardRequest(row.envelope, {
        originDomain,
        senderKey: row.senderKey,
        senderOwnerId: row.senderOwnerId,
        now,
      }));
      signed = signForwardRequest(canonicalBytes, identity);
    } catch {
      const { updated } = await finalize(repository, row, 'dead_letter', {
        attemptCount: row.attemptCount,
        reasonCode: 'FORWARD_BUILD_FAILED',
      });
      if (updated) {
        counts.deadLettered += 1;
        await repository.recordAuditEvent({
          ...auditBase,
          eventType: 'federation.dead_letter',
          outcome: 'rejected',
          reason: 'FORWARD_BUILD_FAILED',
          payload: { reason_code: 'FORWARD_BUILD_FAILED' },
        }).catch(() => {});
      }
      continue;
    }

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

    await settleForward({
      repository, row, auditBase, counts, nowMs, outcome, transportFailed, transportReason,
    });
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
      console.error(`sigil: federation reaper pass failed: ${error?.message ?? error}`);
    }
  }, intervalMs).unref();
}
