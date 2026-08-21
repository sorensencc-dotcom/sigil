import fs from 'node:fs';
import path from 'node:path';
import { formatInboxItem } from '../cli/inbox-wait.mjs';

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
  if (fs.existsSync(lastSeenPath)) {
    const raw = fs.readFileSync(lastSeenPath, 'utf8').trim();
    lastSeenTimestamp = parseInt(raw, 10) || 0;
  }

  const rawLedger = fs.readFileSync(ledgerPath, 'utf8');
  const lines = rawLedger.split('\n').filter(Boolean);
  const unreadItems = [];
  let newestTimestamp = lastSeenTimestamp;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const envelope = entry?.envelope ?? entry;
      const rawDate = entry.received_at || envelope.created_at || entry.created_at;
      const entryTime = rawDate ? new Date(rawDate).getTime() : 0;

      if (entryTime > lastSeenTimestamp) {
        unreadItems.push(entry);
        if (entryTime > newestTimestamp) {
          newestTimestamp = entryTime;
        }
      }
    } catch {
      // Ignore corrupted or partial lines in the local log
    }
  }

  if (unreadItems.length === 0) {
    return [];
  }

  fs.mkdirSync(path.dirname(lastSeenPath), { recursive: true });
  fs.writeFileSync(lastSeenPath, String(newestTimestamp), 'utf8');

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
