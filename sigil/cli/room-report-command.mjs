// Phase 5 Task 12: `sigil room report` — CLI over the Ironbots report poster.
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { loadIdentity, identityKeys } from './identity.mjs';
import { LocalOutbox } from '../connectors/v1/local-outbox.mjs';
import { RelayClient } from '../connectors/v1/relay-client.mjs';
import {
  BOT_ID_PATTERN,
  buildFleetReport,
  createReportPolicy,
  createReportState,
  postReport,
} from '../bridges/v1/ironbot-report.mjs';

export const ROOM_REPORT_USAGE =
  'usage: sigil room report --identity <path> --relay-url <url> --room <room_id> (--bot <id> --status <s> --summary <text> [--alert <text> ...] | --from-report <json>) [--state <path>] [--report-at <iso>] [--drop-pending] [--resend-as-new]\n'
  + '   or: sigil room report --state <path> --break-lock <bot>\n'
  + '   or: sigil room report --state <path> --break-state-lock';

const EXIT = Object.freeze({
  OK: 0,
  USAGE: 1,
  REFUSED: 2,
  TRANSIENT: 3,
});

function usageError(message) {
  const error = new Error(message);
  error.exitCode = EXIT.USAGE;
  error.code = 'USAGE';
  return error;
}

function defaultStatePath(endpointId) {
  return path.join('.sigil', `report-state-${endpointId}.json`);
}

function mapOutcome(reason) {
  if (reason === 'refused') return EXIT.REFUSED;
  if (reason === 'transient' || reason === 'pending' || reason === 'lock_timeout') return EXIT.TRANSIENT;
  return EXIT.OK;
}

function printEvent(log, event, fields = {}) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
  const line = parts.length ? `${event} ${parts.join(' ')}` : event;
  if (log && typeof log.warn === 'function') log.warn(line);
  else console.error(line);
}

/**
 * @param {string[]} argv
 * @param {object} [deps] injectable for tests
 * @returns {Promise<number>} process exit code
 */
export async function runRoomReport(argv, deps = {}) {
  const parse = deps.parseArgs ?? parseArgs;
  const fsImpl = deps.fs ?? fs;
  const loadId = deps.loadIdentity ?? loadIdentity;
  const idKeys = deps.identityKeys ?? identityKeys;
  const Outbox = deps.LocalOutbox ?? LocalOutbox;
  const Client = deps.RelayClient ?? RelayClient;
  const makeState = deps.createReportState ?? createReportState;
  const makePolicy = deps.createReportPolicy ?? createReportPolicy;
  const doPost = deps.postReport ?? postReport;
  const fleetReport = deps.buildFleetReport ?? buildFleetReport;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? {
    info: (...a) => console.error(...a),
    warn: (...a) => console.error(...a),
    error: (...a) => console.error(...a),
  };

  let values;
  try {
    ({ values } = parse({
      args: argv,
      options: {
        identity: { type: 'string' },
        'relay-url': { type: 'string' },
        room: { type: 'string' },
        bot: { type: 'string' },
        status: { type: 'string' },
        summary: { type: 'string' },
        alert: { type: 'string', multiple: true },
        state: { type: 'string' },
        'report-at': { type: 'string' },
        'from-report': { type: 'string' },
        'drop-pending': { type: 'boolean', default: false },
        'resend-as-new': { type: 'boolean', default: false },
        'break-lock': { type: 'string' },
        'break-state-lock': { type: 'boolean', default: false },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    throw usageError(`${ROOM_REPORT_USAGE} (${error.message})`);
  }

  // Operator lock-break forms first: no identity, no post.
  if (values['break-lock'] !== undefined || values['break-state-lock']) {
    const statePath = values.state;
    if (!statePath) throw usageError(`${ROOM_REPORT_USAGE} (--state is required with --break-lock / --break-state-lock)`);
    if (values['break-lock'] !== undefined && values['break-state-lock']) {
      throw usageError(`${ROOM_REPORT_USAGE} (use only one of --break-lock / --break-state-lock)`);
    }
    const state = makeState({ statePath, now });
    if (values['break-state-lock']) {
      const diagnostics = state.breakStateLock();
      printEvent(log, 'report_state_lock_broken_by_operator', { statePath, diagnostics });
      return EXIT.OK;
    }
    const bot = values['break-lock'];
    if (typeof bot !== 'string' || !BOT_ID_PATTERN.test(bot)) {
      throw usageError(`invalid bot id for --break-lock: ${bot}`);
    }
    const diagnostics = state.breakBotLock(bot);
    printEvent(log, 'report_bot_lock_broken_by_operator', { bot, statePath, diagnostics });
    return EXIT.OK;
  }

  const identityPath = values.identity;
  const relayUrl = values['relay-url'];
  const roomId = values.room;
  if (!identityPath) throw usageError(`${ROOM_REPORT_USAGE} (missing --identity)`);
  if (!relayUrl) throw usageError(`${ROOM_REPORT_USAGE} (missing --relay-url)`);
  if (!roomId) throw usageError(`${ROOM_REPORT_USAGE} (missing --room)`);

  const identity = loadId(identityPath);
  const statePath = values.state ?? defaultStatePath(identity.endpoint_id);
  const state = makeState({ statePath, now });
  const policy = makePolicy({ state, now });

  // Resolve bot early for drop-pending / report build.
  let report;
  if (values['from-report']) {
    let raw;
    try {
      raw = JSON.parse(fsImpl.readFileSync(values['from-report'], 'utf8'));
    } catch (error) {
      throw usageError(`cannot read --from-report: ${error.message}`);
    }
    report = fleetReport(raw);
  } else if (values['drop-pending'] && values.bot) {
    report = {
      bot: values.bot,
      status: values.status ?? 'unknown',
      summary: values.summary ?? '',
      alerts: values.alert ?? [],
      timestamp: values['report-at'],
    };
  } else {
    if (!values.bot) throw usageError(`${ROOM_REPORT_USAGE} (missing --bot)`);
    if (!values.status) throw usageError(`${ROOM_REPORT_USAGE} (missing --status)`);
    if (values.summary === undefined) throw usageError(`${ROOM_REPORT_USAGE} (missing --summary)`);
    if (!BOT_ID_PATTERN.test(values.bot)) {
      throw usageError(`invalid bot id: ${values.bot}`);
    }
    report = {
      bot: values.bot,
      status: values.status,
      summary: values.summary,
      alerts: values.alert ?? [],
    };
    if (values['report-at']) report.timestamp = values['report-at'];
  }

  if (!BOT_ID_PATTERN.test(report.bot)) {
    throw usageError(`invalid bot id: ${report.bot}`);
  }

  if (values['drop-pending']) {
    await state.withBotLock(report.bot, async () => {
      await state.dropPending(report.bot);
    });
    printEvent(log, 'report_pending_dropped_by_operator', { bot: report.bot, statePath });
    return EXIT.OK;
  }

  const keys = idKeys(identity);
  const outbox = new Outbox({
    privateKey: keys.privateKey,
    endpoint: {
      owner_id: identity.owner_id,
      endpoint_id: identity.endpoint_id,
      key_id: identity.key_id,
      kind: identity.kind,
    },
  });
  const relay = new Client({ baseUrl: relayUrl, token: identity.relay_token });

  const outcome = await doPost({
    identity,
    relay,
    outbox,
    roomId,
    report,
    policy,
    state,
    now,
    log,
    resendAsNew: Boolean(values['resend-as-new']),
  });

  const reason = outcome?.reason ?? 'transient';
  if (reason === 'already_posted') printEvent(log, 'already_posted', { bot: report.bot });
  else if (reason === 'policy') printEvent(log, 'report_skipped_by_policy', { bot: report.bot });
  else if (reason === 'refused') printEvent(log, 'report_refused', { bot: report.bot });
  else if (reason === 'pending') printEvent(log, 'report_pending_unresolved', { bot: report.bot, detail: outcome });
  else if (reason === 'lock_timeout') printEvent(log, 'lock_timeout', { bot: report.bot });
  else if (reason === 'transient') printEvent(log, 'report_transient', { bot: report.bot });
  else if (reason === 'reconciled') printEvent(log, 'reconciled', { bot: report.bot });
  else if (outcome?.posted) printEvent(log, 'report_posted', { bot: report.bot, reason });

  return mapOutcome(reason);
}

export { EXIT as ROOM_REPORT_EXIT, defaultStatePath };
