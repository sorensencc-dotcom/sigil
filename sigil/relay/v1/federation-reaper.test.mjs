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
function makeRepo({ rows = [], peers = {}, finalizeOverride, directoryLinks = [], markFederationDirectoryLinkExpired } = {}) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  const audits = [];
  const finalizeCalls = [];
  const linkStore = new Map(directoryLinks.map((l) => [l.linkRef, { ...l }]));
  const createLinkCalls = [];
  const expireCalls = [];
  return {
    store,
    audits,
    finalizeCalls,
    linkStore,
    createLinkCalls,
    expireCalls,
    async getFederationDirectoryLinkByRef(linkRef, _client) {
      return linkStore.get(linkRef) ?? null;
    },
    async createFederationDirectoryLink(row, _client) {
      createLinkCalls.push(row);
      if (linkStore.has(row.linkRef)) {
        throw Object.assign(new Error('link exists'), { code: 'FEDERATION_LINK_EXISTS' });
      }
      const rec = { ...row };
      linkStore.set(row.linkRef, rec);
      return rec;
    },
    async markFederationDirectoryLinkExpired(linkRef, reasonCode, now, _client) {
      expireCalls.push({ linkRef, reason: reasonCode });
      if (typeof markFederationDirectoryLinkExpired === 'function') {
        return markFederationDirectoryLinkExpired(linkRef, reasonCode, now);
      }
      const l = linkStore.get(linkRef);
      if (l && l.status === 'pending') { l.status = 'expired'; l.lastReasonCode = reasonCode; return { updated: 1 }; }
      return { updated: 0 };
    },
    async withTransaction(fn) {
      return fn(null);
    },
    async claimDueRelayJobs(jobType, now, limit, leaseSeconds, _client) {
      if (jobType !== 'federation') throw new Error(`unexpected job type ${jobType}`);
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
    async finalizeRelayJob(jobType, id, claimToken, state, patch, _client) {
      if (jobType !== 'federation') throw new Error(`unexpected job type ${jobType}`);
      finalizeCalls.push({ id, claimToken, state, patch });
      if (typeof finalizeOverride === 'function') {
        const res = finalizeOverride({ id, claimToken, state, patch });
        if (res && res.updated === false) return { updated: false };
      }
      const r = store.get(id);
      if (!r || r.claimToken !== claimToken) return { updated: false };
      r.state = state === 'done' ? 'forwarded' : (state === 'rejected' ? 'forward_rejected' : state);
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

// --- Task 11: outbox `kind` dispatch (directory_* rows) --------------------

const DIR_PEERS = { 'b.example': { domain: 'b.example', relayUrl: 'https://b.example/relay' } };

function makeDirRow(overrides = {}) {
  const suffix = crypto.randomUUID();
  return {
    id: `row-${suffix}`,
    kind: 'directory_confirmation',
    recipientDomain: 'b.example',
    state: 'pending',
    attemptCount: 0,
    nextAttemptAt: null,
    claimToken: null,
    lastReasonCode: null,
    // The reaper now rebuilds the signed request each pass, so a queued row
    // carries only { link_ref }.
    directoryPayload: { link_ref: 'L1' },
    ...overrides,
  };
}

test('a directory_confirmation row posts a rebuilt {link_ref,nonce,signed_at} body via postDirectory to /confirmations', async () => {
  const posts = [];
  const postDirectoryImpl = async (peer, path, bytes) => {
    posts.push({ relayUrl: peer.relayUrl, path, body: JSON.parse(Buffer.from(bytes).toString()) });
    return { ok: true, status: 202 };
  };
  const row = makeDirRow({ id: 'r1' });
  const repo = makeRepo({ rows: [row], peers: DIR_PEERS });
  const counts = await runFederationReaperPass({
    repository: repo,
    identity: makeIdentity(),
    originDomain: 'a.example',
    now: new Date('2026-09-05T00:00:00.000Z'),
    // `signed_at` is stamped from the per-row SEND clock (Critical #1); mirror
    // the fake pass clock into it so the exact-value assertion below is stable.
    nowProvider: () => new Date('2026-09-05T00:00:00.000Z'),
    postDirectoryImpl,
  });
  assert.equal(counts.forwarded, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].relayUrl, 'https://b.example/relay');
  assert.equal(posts[0].path, '/v1/federation/directory/confirmations');
  assert.equal(posts[0].body.link_ref, 'L1');
  assert.match(posts[0].body.nonce, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(posts[0].body.signed_at, '2026-09-05T00:00:00.000Z');
  assert.deepEqual(Object.keys(posts[0].body).sort(), ['link_ref', 'nonce', 'signed_at']);
  assert.equal(repo.store.get('r1').state, 'forwarded');
});

test('a directory_revocation row posts a rebuilt body to /revocations', async () => {
  const posts = [];
  const postDirectoryImpl = async (peer, path, bytes) => {
    posts.push({ path, body: JSON.parse(Buffer.from(bytes).toString()) });
    return { ok: true, status: 202 };
  };
  const row = makeDirRow({ id: 'rv1', kind: 'directory_revocation', directoryPayload: { link_ref: 'LR1' } });
  const repo = makeRepo({ rows: [row], peers: DIR_PEERS });
  const counts = await runFederationReaperPass({
    repository: repo, identity: makeIdentity(), originDomain: 'a.example', now: new Date('2026-09-05T00:00:00.000Z'), postDirectoryImpl,
  });
  assert.equal(counts.forwarded, 1);
  assert.equal(posts[0].path, '/v1/federation/directory/revocations');
  assert.equal(posts[0].body.link_ref, 'LR1');
  assert.match(posts[0].body.nonce, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(repo.store.get('rv1').state, 'forwarded');
});

test('B3: a directory_confirmation row is re-signed with a fresh nonce + signed_at on every pass', async () => {
  const sent = [];
  const postDirectoryImpl = async (_peer, _path, canonicalBytes) => {
    sent.push(JSON.parse(Buffer.from(canonicalBytes).toString('utf8')));
    if (sent.length === 1) throw Object.assign(new Error('down'), { code: 'FORWARD_TRANSPORT_FAILED' });
    return { ok: true, status: 202 };
  };
  const row = makeDirRow({ id: 'b3', directoryPayload: { link_ref: 'L_B3' } });
  const repo = makeRepo({ rows: [row], peers: DIR_PEERS });
  const identity = makeIdentity();

  // Pass 1: transport failure re-queues the row (attempt 1, +60s backoff).
  const now1 = new Date('2026-09-05T00:00:00.000Z');
  // `signed_at` now comes from the per-row SEND clock (Critical #1), so the
  // fake pass clock has to be mirrored into `nowProvider` for this assertion to
  // stay deterministic; in production the two passes are >= 60s apart.
  const c1 = await runFederationReaperPass({ repository: repo, identity, originDomain: 'a.example', now: now1, nowProvider: () => now1, postDirectoryImpl });
  assert.equal(c1.failed, 1);
  assert.equal(repo.store.get('b3').state, 'pending');

  // Pass 2: `now` advanced past the backoff; the row is rebuilt + re-signed.
  const now2 = new Date(now1.getTime() + 61_000);
  const c2 = await runFederationReaperPass({ repository: repo, identity, originDomain: 'a.example', now: now2, nowProvider: () => now2, postDirectoryImpl });
  assert.equal(c2.forwarded, 1);
  assert.equal(repo.store.get('b3').state, 'forwarded');

  assert.equal(sent.length, 2);
  assert.equal(sent[0].link_ref, 'L_B3');
  assert.notEqual(sent[0].nonce, sent[1].nonce);
  assert.notEqual(sent[0].signed_at, sent[1].signed_at);
  assert.match(sent[1].nonce, /^[A-Za-z0-9_-]{22}$/);
});

test('the send clock advances per row: a slow first dispatch does not stamp row 2 with a stale signed_at', async () => {
  // Critical #1. `postDirectory` has a 5s timeout, so one unreachable peer with
  // a queue of rows can burn minutes of wall-clock inside a SINGLE pass. If
  // `signed_at` were stamped from the pass-start clock, every row dispatched
  // after the freshness window (300s) elapsed would arrive at the receiver as
  // RELAY_REQUEST_STALE -> 401 -> the terminal forward_rejected branch.
  // The fake clock below advances 400s (> the 300s window) between row 1 and
  // row 2, exactly like a hung peer would.
  const PASS_START = new Date('2026-09-05T00:00:00.000Z');
  let clockMs = PASS_START.getTime();
  const sent = [];
  const postDirectoryImpl = async (_peer, _path, canonicalBytes) => {
    sent.push({ dispatchedAtMs: clockMs, body: JSON.parse(Buffer.from(canonicalBytes).toString('utf8')) });
    clockMs += 400_000; // the peer hung until well past the freshness window
    return { ok: true, status: 202 };
  };
  const rows = [
    makeDirRow({ id: 'slow1', directoryPayload: { link_ref: 'L_SLOW_1' } }),
    makeDirRow({ id: 'slow2', directoryPayload: { link_ref: 'L_SLOW_2' } }),
  ];
  const repo = makeRepo({ rows, peers: DIR_PEERS });

  const counts = await runFederationReaperPass({
    repository: repo,
    identity: makeIdentity(),
    originDomain: 'a.example',
    now: PASS_START,
    nowProvider: () => new Date(clockMs),
    postDirectoryImpl,
  });

  assert.equal(counts.forwarded, 2);
  assert.equal(sent.length, 2);
  // Row 1 is stamped at (its own) dispatch time, which is also the pass start.
  assert.equal(Date.parse(sent[0].body.signed_at), sent[0].dispatchedAtMs);
  // Row 2's signed_at must be fresh relative to ITS dispatch, not the pass
  // start -- which is now 400s (> the 300s freshness window) in the past.
  assert.equal(Date.parse(sent[1].body.signed_at), sent[1].dispatchedAtMs);
  assert.ok(
    Math.abs(Date.parse(sent[1].body.signed_at) - sent[1].dispatchedAtMs) <= 300_000,
    'row 2 was signed with a stale clock: the receiver would reject it RELAY_REQUEST_STALE',
  );
  assert.notEqual(sent[0].body.signed_at, sent[1].body.signed_at);
});

test('the pass clock still drives lease/backoff/audit even when the send clock advances mid-pass', async () => {
  // The companion to the test above: only `signed_at` is per-row. Backoff
  // arithmetic (`nextAttemptAt`) and audit timestamps must stay anchored to the
  // pass clock, so a mid-pass send-clock advance must not move them.
  const PASS_START = new Date('2026-09-05T00:00:00.000Z');
  let clockMs = PASS_START.getTime();
  const repo = makeRepo({ rows: [makeDirRow({ id: 'anchor' })], peers: DIR_PEERS });
  const counts = await runFederationReaperPass({
    repository: repo,
    identity: makeIdentity(),
    originDomain: 'a.example',
    now: PASS_START,
    nowProvider: () => new Date((clockMs += 400_000)),
    postDirectoryImpl: async () => { throw Object.assign(new Error('boom'), { code: 'FORWARD_TRANSPORT_FAILED' }); },
  });
  assert.equal(counts.failed, 1);
  assert.equal(repo.store.get('anchor').nextAttemptAt, new Date(PASS_START.getTime() + 60_000).toISOString());
  assert.equal(repo.audits.at(-1).now, PASS_START);
});

test('a directory_confirmation transport failure walks the same 1m backoff as an envelope row', async () => {
  const repo = makeRepo({ rows: [makeDirRow({ id: 'r3' })], peers: DIR_PEERS });
  const now = new Date('2026-08-31T00:00:00Z');
  const throwTransport = async () => {
    throw Object.assign(new Error('boom'), { code: 'FORWARD_TRANSPORT_FAILED' });
  };
  const counts = await runFederationReaperPass({
    repository: repo, identity: makeIdentity(), originDomain: 'a.example', now, postDirectoryImpl: throwTransport,
  });
  assert.deepEqual(counts, { claimed: 1, forwarded: 0, rejected: 0, failed: 1, deadLettered: 0 });
  const stored = repo.store.get('r3');
  assert.equal(stored.state, 'pending');
  assert.equal(stored.attemptCount, 1);
  assert.equal(stored.nextAttemptAt, new Date(now.getTime() + 60_000).toISOString());
  assert.equal(repo.audits.at(-1).eventType, 'federation.forward_unavailable');
  assert.equal(repo.audits.at(-1).payload.kind, 'directory_confirmation');
});

test('a directory_confirmation that the peer 4xx-rejects -> forward_rejected, no directory-link side effects', async () => {
  const repo = makeRepo({ rows: [makeDirRow({ id: 'r2', directoryPayload: { link_ref: 'L2' } })], peers: DIR_PEERS });
  const postDirectoryImpl = async () => ({ ok: false, status: 403, peerCode: 'DIRECTORY_LINK_REQUIRED' });
  const counts = await runFederationReaperPass({
    repository: repo, identity: makeIdentity(), originDomain: 'a.example', now: new Date('2026-09-05T00:00:00.000Z'), postDirectoryImpl,
  });
  assert.equal(counts.rejected, 1);
  assert.equal(repo.store.get('r2').state, 'forward_rejected');
  assert.equal(repo.store.get('r2').lastReasonCode, 'DIRECTORY_LINK_REQUIRED');
  assert.equal(repo.createLinkCalls.length, 0, 'no redemption link write remains');
  assert.equal(repo.expireCalls.length, 0, 'no link-expire follow-up remains');
});

test('kind = envelope rows are unaffected: dispatch uses buildForwardRequest/postForward, not postDirectory', async () => {
  const row = makeRow();
  const repo = makeRepo({ rows: [row], peers: PEERS });
  let dirCalled = false;
  const counts = await runFederationReaperPass({
    repository: repo,
    identity: makeIdentity(),
    originDomain: ORIGIN_DOMAIN,
    now: new Date('2026-08-31T00:00:00Z'),
    postForwardImpl: async () => ({ ok: true, status: 202 }),
    postDirectoryImpl: async () => { dirCalled = true; return { ok: true, status: 202 }; },
  });
  assert.equal(dirCalled, false, 'an envelope row must never reach postDirectory');
  assert.equal(counts.forwarded, 1);
  assert.equal(repo.store.get(row.id).state, 'forwarded');
  const audit = repo.audits.find((a) => a.eventType === 'federation.forwarded');
  assert.ok(audit);
  assert.ok(!('kind' in (audit.payload ?? {})), 'envelope audit payload must not carry a kind field');
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

test('a directory_revocation transport failure walks full 1m -> 5m -> 30m -> dead_letter backoff', async () => {
  const row = makeDirRow({ id: 'r_walk', kind: 'directory_revocation', directoryPayload: { link_ref: 'L_WALK' } });
  const repo = makeRepo({ rows: [row], peers: DIR_PEERS });
  const identity = makeIdentity();
  const throwTransport = async () => {
    throw Object.assign(new Error('boom'), { code: 'FORWARD_TRANSPORT_FAILED' });
  };

  // Attempt 1: 1m
  const now1 = new Date('2026-08-31T00:00:00Z');
  const c1 = await runFederationReaperPass({ repository: repo, identity, originDomain: 'a.example', now: now1, postDirectoryImpl: throwTransport });
  assert.equal(c1.failed, 1);
  let stored = repo.store.get('r_walk');
  assert.equal(stored.state, 'pending');
  assert.equal(stored.attemptCount, 1);
  assert.equal(stored.nextAttemptAt, new Date(now1.getTime() + 60_000).toISOString());

  // Attempt 2: 5m
  const now2 = new Date(now1.getTime() + 61_000);
  const c2 = await runFederationReaperPass({ repository: repo, identity, originDomain: 'a.example', now: now2, postDirectoryImpl: throwTransport });
  assert.equal(c2.failed, 1);
  stored = repo.store.get('r_walk');
  assert.equal(stored.state, 'pending');
  assert.equal(stored.attemptCount, 2);
  assert.equal(stored.nextAttemptAt, new Date(now2.getTime() + 300_000).toISOString());

  // Attempt 3: 30m
  const now3 = new Date(now2.getTime() + 301_000);
  const c3 = await runFederationReaperPass({ repository: repo, identity, originDomain: 'a.example', now: now3, postDirectoryImpl: throwTransport });
  assert.equal(c3.failed, 1);
  stored = repo.store.get('r_walk');
  assert.equal(stored.state, 'pending');
  assert.equal(stored.attemptCount, 3);
  assert.equal(stored.nextAttemptAt, new Date(now3.getTime() + 1_800_000).toISOString());

  // Attempt 4: dead_letter (no directory-link follow-up remains)
  const now4 = new Date(now3.getTime() + 1_800_001);
  const c4 = await runFederationReaperPass({ repository: repo, identity, originDomain: 'a.example', now: now4, postDirectoryImpl: throwTransport });
  assert.equal(c4.deadLettered, 1);
  stored = repo.store.get('r_walk');
  assert.equal(stored.state, 'dead_letter');
  assert.equal(stored.attemptCount, 4);
});
