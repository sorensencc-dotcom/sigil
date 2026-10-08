import type { HistoryItem } from '../api/types';
import { toSeq } from './seq';

export interface PendingMessage {
  idempotencyKey: string;
  text: string;
  status: 'sending' | 'failed';
  error?: string;
  messageId?: string;
  retryable?: boolean;
}

export interface Row {
  key: string;
  seq: bigint | null;
  item: HistoryItem | null;
  pending?: PendingMessage;
}

export function mergeRows(history: HistoryItem[], pending: PendingMessage[]): Row[] {
  const bySeq = new Map<string, Row>();
  for (const item of history) {
    const seq = toSeq(item.room_seq);
    bySeq.set(seq.toString(), { key: `seq:${seq}`, seq, item });
  }
  const rows = [...bySeq.values()].sort((a, b) => (a.seq! < b.seq! ? -1 : a.seq! > b.seq! ? 1 : 0));
  const knownIds = new Set(rows.map((row) => row.item!.message_id));
  for (const message of pending) {
    if (message.messageId && knownIds.has(message.messageId)) continue;
    rows.push({ key: `pending:${message.idempotencyKey}`, seq: null, item: null, pending: message });
  }
  return rows;
}
