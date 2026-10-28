// Ironbots report poster: sanitize, policy, durable pending, FRESH/RECONCILE.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock, breakLockFile, renameWithRetry } from './file-lock.mjs';

export const FRESH_MS = 4 * 60 * 1000;
export const BOT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_LOCK_WAIT_MS = 5_000;
const BOT_LOCK_WAIT_MS = 60_000;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const REPLY_TTL_MS = 24 * 3600_000;

const CONTENT_REFUSALS = new Set([
  'REPORT_MENTIONS_FORBIDDEN',
  'REPORT_THREAD_FORBIDDEN',
  'REPORT_MESSAGE_TYPE_FORBIDDEN',
  'REPORT_TEXT_TOO_LONG',
]);
const FIRST_SEND_REFUSALS = new Set([
  'INVALID_ENVELOPE',
  'DUPLICATE_MESSAGE',
  'REPLAY_DETECTED',
]);
const TRANSIENT_STATUSES = new Set([401, 403, 408, 425, 429, 500, 503]);

function assertBotId(bot) {
  if (typeof bot !== 'string' || !BOT_ID_PATTERN.test(bot)) {
    throw Object.assign(new Error(`invalid bot id: ${bot}`), { code: 'INVALID_BOT_ID' });
  }
}

export function sanitizeField(value, max) {
  let text = String(value ?? '');
  text = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
  text = text.replace(/[\u202A-\u202E\u2066-\u2069]/g, '');
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, '');
  text = text.replace(/[^\x20-\x7E]/g, '');
  if (text.length > max) text = text.slice(0, max);
  return text;
}

export function buildReportText({ bot, status, timestamp, summary, alerts = [] }) {
  const lines = [
    `bot: ${sanitizeField(bot, 64)}`,
    `status: ${sanitizeField(status, 64)}`,
    `timestamp: ${sanitizeField(timestamp, 64)}`,
    `summary: ${sanitizeField(summary, 500)}`,
  ];
  for (const alert of alerts) {
    lines.push(`alert: ${sanitizeField(alert, 200)}`);
  }
  let text = lines.join('\n');
  if (text.length > 4000) text = text.slice(0, 4000);
  return text;
}

export function buildFleetReport(reportJson) {
  const src = reportJson && typeof reportJson === 'object' ? reportJson : {};
  const status = sanitizeField(src.fleetStatus ?? 'unknown', 64);
  const score = src.fleetHealthScore;
  const botCount = src.botCount;
  const active = Array.isArray(src.activeBots) ? src.activeBots : [];
  const alerts = Array.isArray(src.alerts) ? src.alerts.map((a) => sanitizeField(a, 200)) : [];
  const summary = sanitizeField(
    `fleet score=${score ?? '?'} bots=${botCount ?? active.length} active=${active.length}`,
    500,
  );
  const timestamp = sanitizeField(src.timestamp ?? src.generated_at ?? new Date().toISOString(), 64);
  return { bot: 'fleet', status, timestamp, summary, alerts };
}

export function reportIdempotencyKey(bot, timestamp, recreate_count = 0) {
  const base = `ironbots_${bot}_${timestamp}`;
  return recreate_count > 0 ? `${base}_r${recreate_count}` : base;
}

export function baseKey(key) {
  return String(key ?? '').replace(/_r[0-9]+$/, '');
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyBot() {
  return { status: null, at: null, last_key: null, recreate_count: 0, pending: null };
}

export function createReportState({ statePath, now = () => new Date(), lockOptions = {}, rename } = {}) {
  if (!statePath) throw new Error('statePath is required');
  const renameFn = rename ?? ((from, to) => renameWithRetry(from, to));

  async function withStateLock(fn) {
    const lockPath = `${statePath}.lock`;
    const handle = await acquireLock(lockPath, {
      pollMs: 25,
      now,
      sleep: lockOptions.sleep ?? defaultSleep,
      host: lockOptions.host,
      waitMs: lockOptions.stateWaitMs ?? STATE_LOCK_WAIT_MS,
    });
    try {
      return await fn();
    } finally {
      handle.release();
    }
  }

  function readAll() {
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return { bots: {} };
      throw error;
    }
  }

  function writeAll(all) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const temp = `${statePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(all, null, 2));
    try {
      renameFn(temp, statePath);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* ignore */ }
      throw error;
    }
  }

  async function mutateBot(bot, mutator) {
    assertBotId(bot);
    return withStateLock(async () => {
      const all = readAll();
      if (!all.bots) all.bots = {};
      const current = { ...emptyBot(), ...(all.bots[bot] ?? {}) };
      const next = mutator(current) ?? current;
      all.bots[bot] = next;
      writeAll(all);
      return next;
    });
  }

  return {
    async withBotLock(bot, fn) {
      assertBotId(bot);
      const lockPath = `${statePath}.${bot}.lock`;
      let handle;
      try {
        handle = await acquireLock(lockPath, {
          waitMs: lockOptions.botWaitMs ?? BOT_LOCK_WAIT_MS,
          pollMs: 50,
          now,
          sleep: lockOptions.sleep ?? defaultSleep,
          host: lockOptions.host,
        });
      } catch (error) {
        if (error.code === 'LOCK_TIMEOUT') throw error;
        throw error;
      }
      try {
        return await fn();
      } finally {
        handle.release();
      }
    },
    breakBotLock(bot) {
      assertBotId(bot);
      return breakLockFile(`${statePath}.${bot}.lock`);
    },
    breakStateLock() {
      return breakLockFile(`${statePath}.lock`);
    },
    async loadPending(bot) {
      assertBotId(bot);
      return withStateLock(async () => (readAll().bots?.[bot]?.pending ?? null));
    },
    async savePending(bot, pending) {
      return mutateBot(bot, (cur) => ({ ...cur, pending }));
    },
    async markSending(bot) {
      return mutateBot(bot, (cur) => {
        if (!cur.pending) return cur;
        return { ...cur, pending: { ...cur.pending, state: 'sending' } };
      });
    },
    async clearPending(bot) {
      return mutateBot(bot, (cur) => ({ ...cur, pending: null }));
    },
    async dropPending(bot) {
      return mutateBot(bot, (cur) => ({ ...cur, pending: null }));
    },
    async lastPosted(bot) {
      assertBotId(bot);
      return withStateLock(async () => {
        const row = readAll().bots?.[bot];
        if (!row || row.last_key == null && row.status == null) return null;
        return { status: row.status, at: row.at, last_key: row.last_key };
      });
    },
    async recordPosted(bot, { status, at, key }) {
      return mutateBot(bot, (cur) => ({
        ...cur,
        status,
        at,
        last_key: key,
        pending: null,
      }));
    },
    async nextRecreateCount(bot) {
      let value = 0;
      await mutateBot(bot, (cur) => {
        value = (cur.recreate_count ?? 0) + 1;
        return { ...cur, recreate_count: value };
      });
      return value;
    },
  };
}

export function createReportPolicy({ state, now = () => new Date() }) {
  return {
    async shouldPost(report) {
      const last = await state.lastPosted(report.bot);
      if (!last || last.status == null) return true;
      const at = last.at ? Date.parse(last.at) : 0;
      const age = now().getTime() - at;
      if (report.bot === 'fleet') return age >= DAY_MS;
      if (report.status !== last.status) return true;
      if (report.status !== 'healthy') return true;
      return age >= DAY_MS;
    },
    async record(report) {
      // Policy record is optional; lastPosted is written by postReport on accept.
      return report;
    },
  };
}

function logLine(log, event, fields = {}) {
  if (!log) return;
  const payload = { event, ...fields };
  if (typeof log === 'function') log(payload);
  else if (typeof log.info === 'function') log.info(payload);
  else if (typeof log === 'object' && typeof log.write === 'function') log.write(JSON.stringify(payload));
}

function isTransientError(error) {
  if (!error) return true;
  if (CONTENT_REFUSALS.has(error.code)) return false;
  if (FIRST_SEND_REFUSALS.has(error.code)) return false;
  if (TRANSIENT_STATUSES.has(error.status)) return true;
  if (error.code === 'REPORT_RATE_LIMITED') return true;
  if (error.name === 'AbortError') return true;
  if (typeof error.message === 'string' && /network|ECONN|ETIMEDOUT|fetch/i.test(error.message)) return true;
  // unclassified 4xx / unknown -> transient
  return true;
}

async function receiptsLookup(relay, messageId) {
  try {
    const body = await relay.getMessageReceipts(messageId);
    return { ok: true, status: 200, body };
  } catch (error) {
    return { ok: false, status: error.status ?? 0, error };
  }
}

async function sendEnvelope(relay, envelope, httpTimeoutMs) {
  if (typeof relay.sendEnvelope !== 'function') throw new Error('relay.sendEnvelope required');
  const options = { timeoutMs: httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS };
  return relay.sendEnvelope(envelope, undefined, options);
}

function buildEnvelope({ identity, roomId, text, idempotencyKey, createdAt, now }) {
  const created = createdAt ?? now().toISOString();
  const expires = new Date(Date.parse(created) + REPLY_TTL_MS).toISOString();
  return {
    protocol: 'sigil/1',
    message_id: `msg_${crypto.randomUUID()}`,
    conversation_id: roomId,
    message_type: 'room.message',
    broadcast_scope: { conversation_id: roomId },
    correlation_id: null,
    body: { text, mentions: [] },
    context_refs: [],
    capabilities: [],
    idempotency_key: idempotencyKey,
    created_at: created,
    expires_at: expires,
  };
}

async function signAndPersist({ state, bot, outbox, identity, roomId, report, key, now }) {
  const text = buildReportText(report);
  const unsigned = buildEnvelope({
    identity,
    roomId,
    text,
    idempotencyKey: key,
    createdAt: now().toISOString(),
    now,
  });
  const queued = outbox.queue(unsigned);
  const pending = {
    message_id: queued.envelope.message_id,
    idempotency_key: key,
    created_at: queued.envelope.created_at,
    report: {
      status: report.status,
      summary: report.summary,
      timestamp: report.timestamp,
    },
    envelope: queued.envelope,
    state: 'signed',
  };
  await state.savePending(bot, pending);
  return pending;
}

async function handleSendResult({
  result,
  error,
  isRetry,
  state,
  bot,
  pending,
  now,
  log,
  relay,
}) {
  if (!error) {
    const duplicate = Boolean(result?.duplicate);
    await state.recordPosted(bot, {
      status: pending.report.status,
      at: now().toISOString(),
      key: pending.idempotency_key,
    });
    return { posted: true, reason: duplicate ? 'duplicate' : 'accepted', created: !isRetry };
  }

  if (CONTENT_REFUSALS.has(error.code)) {
    await state.clearPending(bot);
    logLine(log, 'report_refused', { bot, code: error.code, message_id: pending.message_id });
    return { posted: false, reason: 'refused' };
  }

  if (FIRST_SEND_REFUSALS.has(error.code)) {
    if (!isRetry) {
      await state.clearPending(bot);
      logLine(log, 'report_refused', { bot, code: error.code, message_id: pending.message_id });
      return { posted: false, reason: 'refused' };
    }
    const receipts = await receiptsLookup(relay, pending.message_id);
    if (receipts.ok) {
      await state.recordPosted(bot, {
        status: pending.report.status,
        at: now().toISOString(),
        key: pending.idempotency_key,
      });
      return { posted: true, reason: 'reconciled' };
    }
    logLine(log, 'report_pending_unresolved', {
      bot,
      message_id: pending.message_id,
      age: now().getTime() - Date.parse(pending.created_at),
      detail: error.code,
    });
    return { posted: false, reason: 'pending' };
  }

  return { posted: false, reason: 'transient' };
}

async function reconcileSending({ state, bot, pending, relay, now, log, resendAsNew, postNewFromPending }) {
  const receipts = await receiptsLookup(relay, pending.message_id);
  if (receipts.ok) {
    await state.recordPosted(bot, {
      status: pending.report.status,
      at: now().toISOString(),
      key: pending.idempotency_key,
    });
    return { posted: true, reason: 'reconciled' };
  }
  if (!resendAsNew) {
    logLine(log, 'report_pending_unresolved', {
      bot,
      message_id: pending.message_id,
      age: now().getTime() - Date.parse(pending.created_at),
    });
    return { posted: false, reason: 'pending' };
  }
  await state.clearPending(bot);
  return postNewFromPending();
}

export async function postReport({
  identity,
  relay,
  outbox,
  roomId,
  report,
  policy,
  state,
  now = () => new Date(),
  log = null,
  resendAsNew = false,
  httpTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
} = {}) {
  if (!report?.bot) throw new Error('report.bot is required');
  const bot = report.bot;

  try {
    return await state.withBotLock(bot, async () => {
      let pending = await state.loadPending(bot);
      const isRetry = pending?.state === 'sending';
      let resolvedPendingKey = null;

      const postNewFromPendingFields = async () => {
        const recreate = await state.nextRecreateCount(bot);
        const pendingReport = {
          bot,
          status: pending.report.status,
          summary: pending.report.summary,
          timestamp: pending.report.timestamp,
          alerts: report.alerts ?? [],
        };
        const key = reportIdempotencyKey(bot, pendingReport.timestamp, recreate);
        logLine(log, 'report_resent_as_new_by_operator', { bot, key, recreate_count: recreate });
        let signed = await signAndPersist({
          state, bot, outbox, identity, roomId, report: pendingReport, key, now,
        });
        await state.markSending(bot);
        signed = { ...signed, state: 'sending' };
        try {
          const result = await sendEnvelope(relay, signed.envelope, httpTimeoutMs);
          return handleSendResult({
            result, error: null, isRetry: false, state, bot, pending: signed, now, log, relay,
          });
        } catch (error) {
          return handleSendResult({
            result: null, error, isRetry: false, state, bot, pending: signed, now, log, relay,
          });
        }
      };

      if (pending) {
        const age = now().getTime() - Date.parse(pending.created_at ?? pending.envelope?.created_at);
        if (age < FRESH_MS) {
          if (pending.state === 'signed') {
            await state.markSending(bot);
            pending = { ...pending, state: 'sending' };
          }
          try {
            const result = await sendEnvelope(relay, pending.envelope, httpTimeoutMs);
            const outcome = await handleSendResult({
              result, error: null, isRetry, state, bot, pending, now, log, relay,
            });
            if (outcome.reason === 'accepted' || outcome.reason === 'duplicate' || outcome.reason === 'reconciled') {
              resolvedPendingKey = pending.idempotency_key;
              const currentKey = report.timestamp != null
                ? reportIdempotencyKey(bot, report.timestamp)
                : null;
              // Same report as the resolved pending: return the FRESH outcome.
              // A different current report falls through to policy / already_posted.
              if (!currentKey || currentKey === baseKey(resolvedPendingKey)) {
                return outcome;
              }
              pending = null;
            } else {
              return outcome;
            }
          } catch (error) {
            return handleSendResult({
              result: null, error, isRetry, state, bot, pending, now, log, relay,
            });
          }
        } else {
          // RECONCILE
          if (pending.state === 'signed') {
            await state.clearPending(bot);
            pending = null;
          } else {
            const outcome = await reconcileSending({
              state, bot, pending, relay, now, log, resendAsNew,
              postNewFromPending: postNewFromPendingFields,
            });
            if (outcome.reason === 'reconciled') {
              resolvedPendingKey = pending.idempotency_key;
              pending = null;
              // reconciled ends the run with no further post in that run per plan:
              // "A receipts-200 reconcile ... ends the run with reconciled, and posts nothing else in that run."
              return outcome;
            }
            if (outcome.reason === 'pending') return outcome;
            // resendAsNew path may have posted; then continue to policy for current
            if (outcome.posted) {
              // After operator resend, continue to decide whether current report is also due.
              pending = null;
              const leftover = await state.loadPending(bot);
              if (leftover) return { posted: false, reason: 'pending' };
            } else {
              return outcome;
            }
          }
        }
      }

      // Unresolved pending still present?
      pending = pending ?? await state.loadPending(bot);
      if (pending) {
        const currentKey = report.timestamp != null
          ? reportIdempotencyKey(bot, report.timestamp)
          : null;
        if (currentKey && currentKey === baseKey(pending.idempotency_key)) {
          logLine(log, 'report_pending_unresolved', {
            bot,
            message_id: pending.message_id,
            age: now().getTime() - Date.parse(pending.created_at),
          });
          return { posted: false, reason: 'pending' };
        }
        // Different timestamp but unresolved pending blocks new reports
        logLine(log, 'report_pending_unresolved', {
          bot,
          message_id: pending.message_id,
          age: now().getTime() - Date.parse(pending.created_at),
        });
        return { posted: false, reason: 'pending' };
      }

      const timestamp = report.timestamp ?? now().toISOString();
      const reportWithTs = { ...report, timestamp };

      const last = await state.lastPosted(bot);
      const key = reportIdempotencyKey(bot, timestamp);
      if (last?.last_key && key === baseKey(last.last_key)) {
        return { posted: false, reason: 'already_posted' };
      }
      if (resolvedPendingKey && key === baseKey(resolvedPendingKey)) {
        return { posted: false, reason: 'already_posted' };
      }

      if (policy && !(await policy.shouldPost(reportWithTs))) {
        return { posted: false, reason: 'policy' };
      }

      let signed = await signAndPersist({
        state, bot, outbox, identity, roomId, report: reportWithTs, key, now,
      });
      await state.markSending(bot);
      signed = { ...signed, state: 'sending' };
      try {
        const result = await sendEnvelope(relay, signed.envelope, httpTimeoutMs);
        return handleSendResult({
          result, error: null, isRetry: false, state, bot, pending: signed, now, log, relay,
        });
      } catch (error) {
        return handleSendResult({
          result: null, error, isRetry: false, state, bot, pending: signed, now, log, relay,
        });
      }
    });
  } catch (error) {
    if (error.code === 'LOCK_TIMEOUT') {
      logLine(log, 'lock_timeout', {
        bot,
        lockPath: error.lockPath,
        diagnostics: error.diagnostics,
        advice: 'a lock older than 5 minutes for a bot lock or 30 s for the state lock is probably abandoned',
      });
      return { posted: false, reason: 'lock_timeout' };
    }
    throw error;
  }
}
