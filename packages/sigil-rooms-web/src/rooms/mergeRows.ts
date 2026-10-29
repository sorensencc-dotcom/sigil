import type { HistoryItem } from '../api/types';
import { toSeq } from './seq';

export interface PendingMessage {
  idempotencyKey: string;
  text: string;
  status: 'sending' | 'failed';
  error?: string;
  messageId?: string;
  retryable?: boolean;
  threadRootId?: string;
}

export interface Row {
  key: string;
  seq: bigint | null;
  item: HistoryItem | null;
  pending?: PendingMessage;
}

// sortSeq lets a thread root sort by its latest reply instead of its own seq.
export function mergeRows(history: HistoryItem[], pending: PendingMessage[], sortSeq: ReadonlyMap<string, bigint> = new Map()): Row[] {
  const bySeq = new Map<string, Row>();
  for (const item of history) {
    const seq = toSeq(item.room_seq);
    bySeq.set(seq.toString(), { key: `seq:${seq}`, seq, item });
  }
  const key = (row: Row) => sortSeq.get(row.item!.message_id) ?? row.seq!;
  const rows = [...bySeq.values()].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    if (left !== right) return left < right ? -1 : 1;
    return a.seq! < b.seq! ? -1 : a.seq! > b.seq! ? 1 : 0;
  });
  const knownIds = new Set(rows.map((row) => row.item!.message_id));
  for (const message of pending) {
    if (message.messageId && knownIds.has(message.messageId)) continue;
    rows.push({ key: `pending:${message.idempotencyKey}`, seq: null, item: null, pending: message });
  }
  return rows;
}
