// packages/relay-jobs-verification/explore.mjs
//
// Exhaustive schedule exploration of the federation reaper's lease protocol.
//
// Code under test (unmodified, imported from the repo):
//   sigil/relay/v1/federation-reaper.mjs   runFederationReaperPass, settleForward
//   sigil/relay/v1/postgres-repository.mjs claimDueRelayJobs, finalizeRelayJob (real SQL)
//   sigil/migrations/*.sql                 the production relay_jobs schema
//
// Two reaper passes ("A" and "B") run against one database. A scheduler parks each
// pass at three kinds of step, then tries EVERY order of those steps (up to the
// preemption bound) and every peer outcome:
//   txn   a database transaction (claim or finalize) starts
//   post  the HTTP POST to the peer relay is about to be sent
// Everything between two parks is atomic, which matches Postgres: the claim and the
// finalize are each one SQL statement.
//
// Usage: node explore.mjs [--scenario name] [--preemptions N] [--json]

import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeDb, applyMigrations, REPO_ROOT } from './pg-harness.mjs';

const load = (rel) => import(pathToFileURL(path.join(REPO_ROOT, rel)).href);
const { runFederationReaperPass } = await load('sigil/relay/v1/federation-reaper.mjs');
const { PostgresRepository } = await load('sigil/relay/v1/postgres-repository.mjs');

const TERMINAL = new Set(['done', 'rejected', 'dead_letter']);
const LEASE_SECONDS = 60;
const ORIGIN = 'local.example.com';
const PEER_DOMAIN = 'remote.example.com';
const SEND_TIMEOUT_MS = 5000; // AbortSignal.timeout in federation-directory-client.mjs postDirectory

// ---------- scheduler ----------

class Run {
  constructor(prefix, preemptionBound) {
    this.prefix = prefix;
    this.bound = preemptionBound;
    this.choices = [];
    this.parked = new Map(); // actor -> resume()
    this.finished = new Set();
    this.trace = [];
    this.idle = null;
  }
  choose(n, label) {
    const depth = this.choices.length;
    const picked = depth < this.prefix.length ? this.prefix[depth] : 0;
    this.choices.push({ n, picked });
    this.trace.push(`${label}=${picked}`);
    return picked;
  }
  point(actor, label) {
    return new Promise((resume) => {
      this.parked.set(actor, { resume, label });
      this.wake();
    });
  }
  done(actor) { this.finished.add(actor); this.wake(); }
  wake() { if (this.idle) { const f = this.idle; this.idle = null; f(); } }
  async schedule(actors, afterStep) {
    let last = null;
    let preemptions = 0;
    const live = new Set(actors);
    // Let every actor run to its first park.
    for (;;) {
      await new Promise((r) => setImmediate(r));
      for (const a of [...live]) if (this.finished.has(a)) live.delete(a);
      if (live.size === 0) return;
      const ready = [...live].filter((a) => this.parked.has(a));
      if (ready.length < live.size) { // someone is still running; wait for them
        await new Promise((r) => { this.idle = r; });
        continue;
      }
      let options = ready.sort();
      if (last && this.parked.has(last) && preemptions >= this.bound) options = [last];
      const pick = options[this.choose(options.length, 'run')];
      if (last && pick !== last && this.parked.has(last)) preemptions += 1;
      last = pick;
      const { resume, label } = this.parked.get(pick);
      this.parked.delete(pick);
      this.trace.push(`${pick}:${label}`);
      resume();
      await new Promise((r) => { this.idle = r; });
      await afterStep();
    }
  }
}

// ---------- scenario ----------

function identity() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return { private_key_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), key_id: 'relay-key-1' };
}

const SCENARIOS = {
  // One job, B arrives while A's lease is still valid or after it expired.
  'one-job': { jobs: [{ attempts: 0 }], outcomes: ['ok', 'transport', 'reject'], bOffsets: [5, 120], crash: false },
  // Same, but the next transport failure is the fourth and dead-letters the job.
  'one-job-last-attempt': { jobs: [{ attempts: 3 }], outcomes: ['ok', 'transport', 'reject'], bOffsets: [120], crash: false },
  // Two jobs claimed in one batch: A reaches the second after its lease expired.
  'two-jobs': { jobs: [{ attempts: 0 }, { attempts: 0 }], outcomes: ['ok', 'transport'], bOffsets: [120], crash: false },
  // A's pass dies with an unexpected error mid-batch.
  'crash': { jobs: [{ attempts: 0 }, { attempts: 0 }], outcomes: ['ok'], bOffsets: [5, 120], crash: true },
  // Two directory rows. A reaches row 2 after its lease expired, same shape as two-jobs.
  'directory-two-jobs': { kind: 'directory_confirmation', jobs: [{ attempts: 0 }, { attempts: 0 }], outcomes: ['ok', 'transport'], bOffsets: [120], crash: false },
};

export const PROPERTIES = {
  'lease-respected': 'a reaper claims a job only when it is due, or its previous lease has expired',
  'finalize-owner-only': 'a finalize changes a job only when it carries the job\'s current claim token',
  'terminal-absorbing': 'a job that reached done / rejected / dead_letter never changes state again',
  'accounting-exact': 'each applied finalize is counted and audited once; a discarded one is not',
  'no-stuck-processing': 'when both passes finish without error, no job stays in processing',
  'abandoned-recoverable': 'a later pass completes every job an earlier pass left behind',
  'send-owner-only': 'a reaper POSTs a job to the peer only while it holds that job\'s lease',
};

async function runOnce(env, name, cfg, prefix, bound) {
  const { db, pool, repo } = env;
  await db.exec('TRUNCATE relay_jobs, audit_events, peer_relays CASCADE');
  await db.query(
    `INSERT INTO peer_relays (domain, relay_url, keys, trust_mode) VALUES ($1, 'https://remote.example.com', '[]'::jsonb, 'static')`,
    [PEER_DOMAIN]);
  const ids = [];
  for (const [i, j] of cfg.jobs.entries()) {
    const messageId = cfg.kind ? `link-${i}` : `msg-${i}`;
    const common = {
      messageId, idempotencyKey: `idem-${i}`, recipientDomain: PEER_DOMAIN, originDomain: ORIGIN,
      now: new Date(Date.now() - 1000),
    };
    const { row } = await repo.enqueueFederationForward(cfg.kind
      ? { ...common, kind: cfg.kind, directoryPayload: { link_ref: messageId } }
      : {
        ...common,
        envelope: { message_id: messageId, expires_at: '2999-01-01T00:00:00Z', sender: { endpoint_id: 'ep_codex@local.example.com' } },
        senderKey: { kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' }, senderOwnerId: 'owner-1',
      });
    ids.push(row.id);
    if (j.attempts) await db.query('UPDATE relay_jobs SET attempt_count = $2 WHERE id = $1', [row.id, j.attempts]);
  }

  const run = new Run(prefix, bound);
  const violations = [];
  const flag = (property, detail) => violations.push({ property, detail });
  const held = { A: new Map(), B: new Map() }; // actor -> job id -> claim token
  const inflight = { A: null, B: null }; // actor -> { id, ts } while renewed and not yet posted
  const finals = [];
  const results = {};
  const aborted = new Set();
  const id2msg = new Map();
  const T0 = Date.now();
  const bOffset = cfg.bOffsets[run.choose(cfg.bOffsets.length, 'bOffset')];
  const clocks = { A: new Date(T0), B: new Date(T0 + bOffset * 1000) };
  const identityKey = identity();
  const terminalSeen = new Map();
  const jobRows = async () => (await db.query('SELECT id, message_id, state, claim_token, claimed_at, next_attempt_at, attempt_count FROM relay_jobs ORDER BY message_id')).rows;
  for (const r of await jobRows()) id2msg.set(r.id, r.message_id);

  const view = (actor) => new Proxy(repo, {
    get(target, prop) {
      if (prop === 'withTransaction') {
        return async (fn) => { await run.point(actor, 'txn'); return target.withTransaction(fn); };
      }
      if (prop === 'claimDueRelayJobs') {
        return async (jobType, nowArg, limit, leaseSeconds, client) => {
          // Assumption: a POST ends within SEND_TIMEOUT_MS (postDirectory's 5s abort).
          // A rival claim cannot run at a clock past an in-flight send's deadline.
          let now = nowArg;
          for (const [other, f] of Object.entries(inflight)) {
            if (other !== actor && f) now = new Date(Math.min(now.getTime(), f.ts.getTime() + SEND_TIMEOUT_MS));
          }
          const before = (await client.query('SELECT id, state, claimed_at, next_attempt_at FROM relay_jobs')).rows;
          const rows = await target.claimDueRelayJobs(jobType, now, limit, leaseSeconds, client);
          for (const r of rows) {
            const b = before.find((x) => x.id === r.id);
            const nowMs = now.getTime();
            if (b.state === 'processing' && !(new Date(b.claimed_at).getTime() < nowMs - leaseSeconds * 1000)) {
              flag('lease-respected', `${actor} claimed ${id2msg.get(r.id)} while another reaper's lease was still valid`);
            } else if (b.state === 'pending' && new Date(b.next_attempt_at).getTime() > nowMs) {
              flag('lease-respected', `${actor} claimed ${id2msg.get(r.id)} before its next_attempt_at`);
            } else if (TERMINAL.has(b.state)) {
              flag('lease-respected', `${actor} claimed ${id2msg.get(r.id)} in terminal state ${b.state}`);
            }
            held[actor].set(r.id, r.claimToken);
          }
          return rows;
        };
      }
      if (prop === 'renewRelayJobLease') {
        return async (jobType, id, token, ts, client) => {
          await run.point(actor, 'renew');
          const res = await target.renewRelayJobLease(jobType, id, token, ts, client);
          if (res.renewed) inflight[actor] = { id, ts };
          return res;
        };
      }
      if (prop === 'finalizeRelayJob') {
        return async (jobType, id, token, state, patch, client) => {
          const b = (await client.query('SELECT state, claim_token FROM relay_jobs WHERE id = $1', [id])).rows[0];
          const res = await target.finalizeRelayJob(jobType, id, token, state, patch, client);
          finals.push({ actor, id, state, updated: res.updated });
          if (res.updated && b.claim_token !== token) {
            flag('finalize-owner-only', `${actor} wrote "${state}" to ${id2msg.get(id)} with a stale token (row was ${b.state})`);
          }
          return res;
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });

  const messageIdOf = (bytes) => {
    const body = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return body.envelope?.message_id ?? body.link_ref;
  };
  const settlePost = async (actor, msg) => {
    await run.point(actor, 'post');
    const id = [...id2msg].find(([, m]) => m === msg)[0];
    const row = (await db.query('SELECT claim_token FROM relay_jobs WHERE id = $1', [id])).rows[0];
    if (held[actor].get(id) !== row.claim_token) {
      flag('send-owner-only', `${actor} POSTed ${msg} to the peer after another reaper took over its lease`);
    }
    const options = ['ok', ...cfg.outcomes.filter((o) => o !== 'ok')];
    if (cfg.crash && actor === 'A') options.push('crash');
    const o = options[run.choose(options.length, `${actor}.peer`)];
    inflight[actor] = null;
    if (o === 'ok') return { ok: true, status: 200 };
    if (o === 'reject') return { ok: false, status: 400, peerCode: 'PEER_REJECTED' };
    if (o === 'crash') throw new Error('unexpected failure');
    throw Object.assign(new Error('transport'), { code: 'FORWARD_TRANSPORT_FAILED' });
  };
  const postFor = (actor) => async (_peer, bytes) => settlePost(actor, messageIdOf(bytes));
  // postDirectory is (peer, path, bytes, signed). postForward is (peer, bytes, signed).
  const postDirFor = (actor) => async (_peer, _path, bytes) => settlePost(actor, messageIdOf(bytes));

  const actorBody = (actor) => async () => {
    try {
      results[actor] = await runFederationReaperPass({
        repository: view(actor), identity: identityKey, originDomain: ORIGIN, now: clocks[actor],
        postForwardImpl: postFor(actor), postDirectoryImpl: postDirFor(actor), limit: 10, leaseSeconds: LEASE_SECONDS,
      });
    } catch { aborted.add(actor); }
    run.done(actor);
  };

  const afterStep = async () => {
    for (const r of await jobRows()) {
      const prev = terminalSeen.get(r.id);
      if (prev && prev !== r.state) flag('terminal-absorbing', `${id2msg.get(r.id)} left ${prev} for ${r.state}`);
      if (TERMINAL.has(r.state)) terminalSeen.set(r.id, r.state);
    }
  };

  const bodies = ['A', 'B'].map((a) => actorBody(a)());
  await run.schedule(['A', 'B'], afterStep);
  await Promise.all(bodies);
  await afterStep();

  // accounting: only comparable when neither pass threw (a throw loses its counts)
  if (aborted.size === 0) {
    const applied = { forwarded: 0, rejected: 0, failed: 0, deadLettered: 0 };
    for (const f of finals.filter((x) => x.updated)) {
      if (f.state === 'done') applied.forwarded += 1;
      else if (f.state === 'rejected') applied.rejected += 1;
      else if (f.state === 'dead_letter') applied.deadLettered += 1;
      else if (f.state === 'pending') applied.failed += 1;
    }
    for (const k of Object.keys(applied)) {
      const counted = (results.A?.[k] ?? 0) + (results.B?.[k] ?? 0);
      if (counted !== applied[k]) flag('accounting-exact', `counted ${counted} "${k}" but ${applied[k]} finalizes applied`);
    }
    const audits = (await db.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE event_type LIKE 'federation.%'`)).rows[0].n;
    const appliedTotal = Object.values(applied).reduce((a, b) => a + b, 0);
    if (audits !== appliedTotal) flag('accounting-exact', `${audits} audit events for ${appliedTotal} applied finalizes`);
    const stuck = (await jobRows()).filter((r) => r.state === 'processing');
    if (stuck.length) flag('no-stuck-processing', `${stuck.map((r) => r.message_id).join(',')} left in processing after both passes finished`);
  }

  // recovery: a clean pass an hour later must finish whatever is left
  await runFederationReaperPass({
    repository: repo, identity: identityKey, originDomain: ORIGIN, now: new Date(T0 + 3600_000),
    postForwardImpl: async () => ({ ok: true, status: 200 }),
    postDirectoryImpl: async () => ({ ok: true, status: 202 }),
    limit: 10, leaseSeconds: LEASE_SECONDS,
  });
  for (const r of await jobRows()) {
    if (!TERMINAL.has(r.state)) flag('abandoned-recoverable', `${r.message_id} still ${r.state} after a clean later pass`);
  }
  return { run, violations };
}

export async function explore(name, { preemptions = 3, maxRuns = 200000 } = {}) {
  const cfg = SCENARIOS[name];
  const { db, pool } = await makeDb();
  await applyMigrations(db);
  const env = { db, pool, repo: new PostgresRepository({ pool }) };
  let prefix = [];
  let runs = 0;
  const first = new Map(); // property -> first counterexample
  const counts = new Map();
  for (;;) {
    const { run, violations } = await runOnce(env, name, cfg, prefix, preemptions);
    runs += 1;
    for (const v of violations) {
      counts.set(v.property, (counts.get(v.property) ?? 0) + 1);
      if (!first.has(v.property)) first.set(v.property, { detail: v.detail, trace: [...run.trace] });
    }
    let i = run.choices.length - 1;
    while (i >= 0 && run.choices[i].picked + 1 >= run.choices[i].n) i -= 1;
    if (i < 0 || runs >= maxRuns) { if (runs >= maxRuns) throw new Error('maxRuns hit: exploration incomplete'); break; }
    prefix = run.choices.slice(0, i).map((c) => c.picked).concat(run.choices[i].picked + 1);
  }
  await db.close();
  return { scenario: name, runs, failing: Object.fromEntries([...first].map(([p, c]) => [p, { schedules: counts.get(p), ...c }])) };
}

export const SCENARIO_NAMES = Object.keys(SCENARIOS);
