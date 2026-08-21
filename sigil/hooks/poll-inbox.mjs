import fs from 'node:fs';
import path from 'node:path';
import { formatInboxItem } from '../cli/inbox-wait.mjs';
import { readInboxLedger } from '../cli/ledger.mjs';

/**
 * Polls local inbox state and outputs unread message summaries to stdout.
 *
 * @param {object} options
 * @param {string} [options.ledgerPath] - Path to the local append-only inbox ledger JSONL
 * @param {string} [options.lastSeenPath] - Path to the file storing the highest seen timestamp
 * @param {Function} [options.output] - Output sink for logging notifications
 * @returns {Promise<Array<object>>} - List of newly processed unread items
 */
export async function pollInbox({
  ledgerPath = process.env.SIGIL_LEDGER_PATH || path.resolve(process.cwd(), '.sigil/inbox-ledger.jsonl'),
  lastSeenPath = process.env.SIGIL_LAST_SEEN_PATH || path.resolve(process.cwd(), '.sigil/.last_seen_cursor'),
  output = console.log
} = {}) {
  if (!fs.existsSync(ledgerPath)) {
    return [];
  }

  let lastSeenTimestamp = 0;
  let lastSeenIds = new Set();
  if (fs.existsSync(lastSeenPath)) {
    const raw = fs.readFileSync(lastSeenPath, 'utf8').trim();
    try {
      const parsed = JSON.parse(raw);
      lastSeenTimestamp = Number(parsed.timestamp) || 0;
      lastSeenIds = new Set(parsed.ids || []);
    } catch {
      // Legacy cursor format: a bare integer timestamp with no id tracking
      lastSeenTimestamp = parseInt(raw, 10) || 0;
    }
  }

  const entries = await readInboxLedger(ledgerPath, { limit: Infinity });
  const unreadItems = [];
  let newestTimestamp = lastSeenTimestamp;
  let newestIds = new Set(lastSeenIds);

  for (const entry of entries) {
    const envelope = entry?.envelope ?? entry;
    const rawDate = entry.received_at || envelope.created_at || entry.created_at;
    const entryTime = rawDate ? new Date(rawDate).getTime() : 0;
    const entryId = envelope.message_id || entry.message_id;

    const isNewer = entryTime > lastSeenTimestamp;
    const isSameTimestampUnseen = entryTime === lastSeenTimestamp && entryTime > 0 && !lastSeenIds.has(entryId);

    if (isNewer || isSameTimestampUnseen) {
      unreadItems.push(entry);
      if (entryTime > newestTimestamp) {
        newestTimestamp = entryTime;
        newestIds = new Set();
      }
      if (entryTime === newestTimestamp) {
        newestIds.add(entryId);
      }
    }
  }

  if (unreadItems.length === 0) {
    return [];
  }

  fs.mkdirSync(path.dirname(lastSeenPath), { recursive: true });
  fs.writeFileSync(lastSeenPath, JSON.stringify({ timestamp: newestTimestamp, ids: [...newestIds] }), 'utf8');

  output('\n[SIGIL INBOX NOTIFICATION]');
  output(`You have ${unreadItems.length} new unread Sigil envelope(s):`);
  for (const item of unreadItems) {
    try {
      output(` - ${formatInboxItem(item)}`);
    } catch {
      const env = item?.envelope ?? item;
      output(` - Message ID: ${env.message_id || 'unknown'} (type: ${env.message_type || 'raw'})`);
    }
  }
  output('Use `sigil_check_inbox` or `sigil_ack_delivery` to inspect and acknowledge.\n');

  return unreadItems;
}

if (process.argv[1]?.endsWith('poll-inbox.mjs')) {
  pollInbox().catch((error) => {
    process.stderr.write(`Sigil poll error: ${error.message}\n`);
    process.exit(0);
  });
}
