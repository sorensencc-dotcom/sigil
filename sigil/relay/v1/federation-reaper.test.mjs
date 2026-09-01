// sigil/relay/v1/federation-reaper.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { runFederationReaperPass, startFederationReaper } from './federation-reaper.mjs';

const ORIGIN_DOMAIN = 'local.example.com';

function makeIdentity() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    private_key_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    key_id: 'relay-key-1',
  };
}

function makeRow(overrides = {}) {
  const suffix = crypto.randomUUID();
  return {
    id: `row-${suffix}`,
    messageId: `msg-${suffix}`,
    idempotencyKey: `idem-${suffix}`,
    recipientDomain: 'remote.example.com',
    originDomain: ORIGIN_DOMAIN,
    envelope: {
      message_id: `msg-${suffix}`,
      expires_at: '2999-01-01T00:00:00Z',
      sender: { endpoint_id: 'ep_codex@local.example.com' },
    },
    senderKey: { kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' },
    senderOwnerId: `owner-${suffix}`,
    state: 'pending',
    attemptCount: 0,
    nextAttemptAt: null,
    claimedAt: null,
    claimToken: null,
    lastReasonCode: null,
    ...overrides,
  };
}

// In-memory fake repository. `withTransaction(fn)` just runs `fn(null)`.
function makeRepo({ rows = [], peers = {}, finalizeOverride } = {}) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  const audits = [];
  const finalizeCalls = [];
  return {
    store,
    audits,
    finalizeCalls,
    async withTransaction(fn) {
      return fn(null);
    },
    async claimDueFederationForwards(now, limit, leaseSeconds, _client) {
      const claimed = [];
      for (const r of store.values()) {
        if (claimed.length >= limit) break;
        if (r.state !== 'pending' && r.state !== 'processing') continue;
        if (r.nextAttemptAt && Date.parse(r.nextAttemptAt) > now.getTime()) continue;
        // Fresh pending -> processing claim: attempt_count untouched (matches SQL).
        r.state = 'processing';
        r.claimToken = `claim-${crypto.randomUUID()}`;
        r.claimedAt = now.toISOString();
        claimed.push({ ...r });
      }
      return claimed;
    },
    async finalizeFederationForward(id, claimToken, state, patch, _client) {
      finalizeCalls.push({ id, claimToken, state, patch });
      if (typeof finalizeOverride === 'function') {
        const res = finalizeOverride({ id, claimToken, state, patch });
        if (res && res.updated === false) return { updated: false };
      }
      const r = store.get(id);
      if (!r || r.claimToken !== claimToken) return { updated: false };
      r.state = state;
      if (patch.attemptCount != null) r.attemptCount = patch.attemptCount;
      r.nextAttemptAt = patch.nextAttemptAt != null
        ? (patch.nextAttemptAt instanceof Date ? patch.nextAttemptAt.toISOString() : patch.nextAttemptAt)
        : null;
      r.lastReasonCode = patch.reasonCode ?? null;
      r.claimToken = null;
      r.claimedAt = null;
      return { updated: true };
    },
    async recordAuditEvent(event) {
      audits.push(event);
    },
    async getPeerByDomain(domain) {
      return peers[domain] ?? null;
    },
  };
}

const PEERS = { 'remote.example.com': { domain: 'remote.example.com', relayUrl: 'https://remote.example.com/relay', keys: [] } };

test('one due row, postForward ok -> row forwarded + federation.forwarded audit', async () => {
  const row = makeRow();
  const repo = makeRepo({ rows: [row], peers: PEERS });
  const now = new Date('2026-08-31T00:00:00Z');
  const seen = [];

  const counts = await runFederationReaperPass({
    repository: repo,
    identity: makeIdentity(),
    originDomain: ORIGIN_DOMAIN,
    now,
    postForwardImpl: async (peer, bytes, signed) => {
      seen.push({ peer, hasSig: typeof signed.signature === 'string', keyId: signed.keyId });
      return { ok: true, status: 202 };
    },
  });

  assert.deepEqual(counts, { claimed: 1, forwarded: 1, rejected: 0, failed: 0, deadLettered: 0 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].peer.relayUrl, 'https://remote.example.com/relay');
  assert.equal(seen[0].hasSig, true);
  assert.equal(seen[0].keyId, 'relay-key-1');
  assert.equal(repo.store.get(row.id).state, 'forwarded');

  const audit = repo.audits.find((a) => a.eventType === 'federation.forwarded');
  assert.ok(audit, 'expected a federation.forwarded audit event');
  assert.equal(audit.subjectId, row.messageId);
  assert.equal(audit.endpointId, 'ep_codex@local.example.com');
  assert.ok(!JSON.stringify(audit.payload ?? {}).includes('expires_at'), 'audit payload must not carry the envelope body');
});

test('4xx from peer -> forward_rejected (terminal) + audit carries peer code', async () => {
  const row = makeRow();
  const repo = makeRepo({ rows: [row], peers: PEERS });
  const now = new Date('2026-08-31T00:00:00Z');

  const counts = await runFederationReaperPass({
    repository: repo,
    identity: makeIdentity(),
    originDomain: ORIGIN_DOMAIN,
    now,
    postForwardImpl: async () => ({ ok: false, status: 403, peerCode: 'DIRECTORY_LINK_REQUIRED' }),
  });

  assert.deepEqual(counts, { claimed: 1, forwarded: 0, rejected: 1, failed: 0, deadLettered: 0 });
  const stored = repo.store.get(row.id);
  assert.equal(stored.state, 'forward_rejected');
  assert.equal(stored.lastReasonCode, 'DIRECTORY_LINK_REQUIRED');

  const audit = repo.audits.find((a) => a.eventType === 'federation.forward_rejected');
  assert.ok(audit, 'expected a federation.forward_rejected audit event');
  assert.equal(audit.payload.peer_code, 'DIRECTORY_LINK_REQUIRED');
});

test('4xx with no valid peer code -> forward_rejected, reason code null', async () => {
  const row = makeRow();
  const repo = makeRepo({ rows: [row], peers: PEERS });
  const counts = await runFederationReaperPass({
    repository: repo,
    identity: makeIdentity(),
    originDomain: ORIGIN_DOMAIN,
    now: new Date('2026-08-31T00:00:00Z'),
    postForwardImpl: async () => ({ ok: false, status: 400 }),
  });
  assert.equal(counts.rejected, 1);
  assert.equal(repo.store.get(row.id).state, 'forward_rejected');
  assert.equal(repo.store.get(row.id).lastReasonCode, null);
  const audit = repo.audits.find((a) => a.eventType === 'federation.forward_rejected');
  assert.equal(audit.payload.peer_code, null);
});

test('four transport failures walk +60s, +300s, +1800s, then dead_letter (all three backoffs used)', async () => {
  const row = makeRow();
  const repo = makeRepo({ rows: [row], peers: PEERS });
  const identity = makeIdentity();
  const throwTransport = async () => {
    throw Object.assign(new Error('forward transport failed: boom'), { code: 'FORWARD_TRANSPORT_FAILED' });
  };

  // Pass 1 — first backoff: 1 minute.
  const now1 = new Date('2026-08-31T00:00:00Z');
  const c1 = await runFederationReaperPass({ repository: repo, identity, originDomain: ORIGIN_DOMAIN, now: now1, postForwardImpl: throwTransport });
  assert.deepEqual(c1, { claimed: 1, forwarded: 0, rejected: 0, failed: 1, deadLettered: 0 });
  let stored = repo.store.get(row.id);
  assert.equal(stored.state, 'pending');
  assert.equal(stored.attemptCount, 1);
  assert.equal(stored.nextAttemptAt, new Date(now1.getTime() + 60_000).toISOString());
  assert.equal(repo.audits.filter((a) => a.eventType === 'federation.forward_unavailable').length, 1);
  assert.equal(repo.audits.at(-1).payload.attempt_count, 1);

  // Pass 2 — second backoff: 5 minutes.
  const now2 = new Date(now1.getTime() + 61_000);
  const c2 = await runFederationReaperPass({ repository: repo, identity, originDomain: ORIGIN_DOMAIN, now: now2, postForwardImpl: throwTransport });
  assert.deepEqual(c2, { claimed: 1, forwarded: 0, rejected: 0, failed: 1, deadLettered: 0 });
  stored = repo.store.get(row.id);
  assert.equal(stored.state, 'pending');
  assert.equal(stored.attemptCount, 2);
  assert.equal(stored.nextAttemptAt, new Date(now2.getTime() + 300_000).toISOString());
  assert.equal(repo.audits.at(-1).payload.attempt_count, 2);

  // Pass 3 — third backoff: 30 minutes (BACKOFF_MS[2], previously unreachable).
  const now3 = new Date(now2.getTime() + 301_000);
  const c3 = await runFederationReaperPass({ repository: repo, identity, originDomain: ORIGIN_DOMAIN, now: now3, postForwardImpl: throwTransport });
  assert.deepEqual(c3, { claimed: 1, forwarded: 0, rejected: 0, failed: 1, deadLettered: 0 });
  stored = repo.store.get(row.id);
  assert.equal(stored.state, 'pending');
  assert.equal(stored.attemptCount, 3);
  assert.equal(stored.nextAttemptAt, new Date(now3.getTime() + 1_800_000).toISOString());
  assert.equal(repo.audits.at(-1).payload.attempt_count, 3);

  // Pass 4 — fourth transport failure dead-letters.
  const now4 = new Date(now3.getTime() + 1_800_001);
  const c4 = await runFederationReaperPass({ repository: repo, identity, originDomain: ORIGIN_DOMAIN, now: now4, postForwardImpl: throwTransport });
  assert.deepEqual(c4, { claimed: 1, forwarded: 0, rejected: 0, failed: 0, deadLettered: 1 });
  stored = repo.store.get(row.id);
  assert.equal(stored.state, 'dead_letter');
  assert.equal(stored.attemptCount, 4);
  const dl = repo.audits.find((a) => a.eventType === 'federation.dead_letter');
  assert.ok(dl, 'expected a federation.dead_letter audit event');
  assert.equal(dl.payload.attempt_count, 4);

  // Pass 5 — nothing left to claim.
  const c5 = await runFederationReaperPass({ repository: repo, identity, originDomain: ORIGIN_DOMAIN, now: new Date(now4.getTime() + 10_000), postForwardImpl: throwTransport });
  assert.equal(c5.claimed, 0);
});

test('null peer (unpinned since enqueue) takes the transport-failure backoff path', async () => {
  const row = makeRow();
  const repo = makeRepo({ rows: [row], peers: {} });
  let postCalled = false;
  const now = new Date('2026-08-31T00:00:00Z');
  const counts = await runFederationReaperPass({
    repository: repo,
    identity: makeIdentity(),
    originDomain: ORIGIN_DOMAIN,
    now,
    postForwardImpl: async () => { postCalled = true; return { ok: true }; },
  });
  assert.equal(postCalled, false, 'postForward must not be called with an undefined relayUrl');
  assert.equal(counts.failed, 1);
  const stored = repo.store.get(row.id);
  assert.equal(stored.state, 'pending');
  assert.equal(stored.attemptCount, 1);
  assert.equal(stored.nextAttemptAt, new Date(now.getTime() + 60_000).toISOString());
  assert.equal(repo.audits.at(-1).eventType, 'federation.forward_unavailable');
});

test('expired envelope -> dead_letter MESSAGE_EXPIRED, no forward attempted', async () => {
  const row = makeRow({ envelope: { message_id: 'm-exp', expires_at: '2000-01-01T00:00:00Z', sender: { endpoint_id: 'ep_x@local.example.com' } } });
  const repo = makeRepo({ rows: [row], peers: PEERS });
  let postCalled = false;
  const counts = await runFederationReaperPass({
    repository: repo,
    identity: makeIdentity(),
    originDomain: ORIGIN_DOMAIN,
    now: new Date('2026-08-31T00:00:00Z'),
    postForwardImpl: async () => { postCalled = true; return { ok: true }; },
  });
  assert.equal(postCalled, false);
  assert.deepEqual(counts, { claimed: 1, forwarded: 0, rejected: 0, failed: 0, deadLettered: 1 });
  assert.equal(repo.store.get(row.id).state, 'dead_letter');
  assert.equal(repo.store.get(row.id).lastReasonCode, 'MESSAGE_EXPIRED');
  const dl = repo.audits.find((a) => a.eventType === 'federation.dead_letter');
  assert.ok(dl);
  assert.equal(dl.reason, 'MESSAGE_EXPIRED');
});

test('stale claim token (finalize updated:false) -> pass does not throw, no audit for that row', async () => {
  const row = makeRow();
  const repo = makeRepo({ rows: [row], peers: PEERS, finalizeOverride: () => ({ updated: false }) });
  const counts = await runFederationReaperPass({
    repository: repo,
    identity: makeIdentity(),
    originDomain: ORIGIN_DOMAIN,
    now: new Date('2026-08-31T00:00:00Z'),
    postForwardImpl: async () => ({ ok: true, status: 202 }),
  });
  assert.equal(counts.claimed, 1);
  assert.equal(counts.forwarded, 0, 'a stolen lease must not be counted as forwarded');
  assert.equal(repo.audits.length, 0, 'no audit event when the lease was stolen');
  assert.equal(repo.finalizeCalls.length, 1);
});

test('poison row (buildForwardRequest throws) -> dead_letter FORWARD_BUILD_FAILED; pass does not throw and a healthy row behind it still forwards', async () => {
  const poison = makeRow({
    envelope: {
      message_id: 'm-poison',
      expires_at: '2999-01-01T00:00:00Z',
      sender: { endpoint_id: 'ep_poison@local.example.com' },
      bad: 10n, // a BigInt cannot be canonicalized -> buildForwardRequest throws
    },
  });
  const healthy = makeRow();
  const repo = makeRepo({ rows: [poison, healthy], peers: PEERS });
  let posted = 0;

  const counts = await runFederationReaperPass({
    repository: repo,
    identity: makeIdentity(),
    originDomain: ORIGIN_DOMAIN,
    now: new Date('2026-08-31T00:00:00Z'),
    postForwardImpl: async () => { posted += 1; return { ok: true, status: 202 }; },
  });

  // (a) poison row: terminal dead_letter, no forward attempted, pass survived.
  assert.equal(repo.store.get(poison.id).state, 'dead_letter');
  assert.equal(repo.store.get(poison.id).lastReasonCode, 'FORWARD_BUILD_FAILED');
  const dl = repo.audits.find((a) => a.eventType === 'federation.dead_letter' && a.subjectId === poison.messageId);
  assert.ok(dl, 'expected a federation.dead_letter audit for the poison row');
  assert.equal(dl.reason, 'FORWARD_BUILD_FAILED');
  assert.equal(dl.payload.reason_code, 'FORWARD_BUILD_FAILED');

  // (b) healthy row queued behind the poison row still forwarded in the same pass.
  assert.equal(posted, 1, 'the healthy row must still be forwarded');
  assert.equal(repo.store.get(healthy.id).state, 'forwarded');

  assert.deepEqual(counts, { claimed: 2, forwarded: 1, rejected: 0, failed: 0, deadLettered: 1 });
});

test('startFederationReaper returns an unref()-d handle and logs a thrown pass without stopping', async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (msg) => { logged.push(String(msg)); };
  const brokenRepo = {
    withTransaction() { throw new Error('db down'); },
  };
  let handle;
  try {
    handle = startFederationReaper({ repository: brokenRepo, identity: makeIdentity(), originDomain: ORIGIN_DOMAIN, intervalMs: 15 });
    assert.equal(typeof handle.unref, 'function', 'handle must be a timer with .unref()');
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    if (handle) clearInterval(handle);
    console.error = originalError;
  }
  assert.ok(logged.length >= 1, 'expected at least one console.error from a failing pass');
  assert.ok(logged.some((l) => l.includes('federation reaper pass failed')), `unexpected log lines: ${logged.join(' | ')}`);
});
