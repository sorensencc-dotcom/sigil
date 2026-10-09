import type { HistoryItem } from '../api/types';
import { toSeq } from './seq';

export function rowsById(items: HistoryItem[]): Map<string, HistoryItem> {
  return new Map(items.map((item) => [item.message_id, item]));
}

// A reply names a thread root; an event or a message with no thread_root_id sits in the main timeline.
export function isTopLevel(item: HistoryItem): boolean {
  return !(item.envelope.message_type === 'room.message' && item.envelope.body.thread_root_id);
}

// body.thread_root_id ?? message_id, followed through the cache. The relay does not normalize
// thread_root_id, so a CLI or bridge message can point at a reply. Stops at a row with no
// thread_root_id, an unloaded row, or a repeat (cycle guard).
export function threadRootOf(item: HistoryItem, byId: Map<string, HistoryItem>): string {
  let id = item.envelope.body.thread_root_id ?? item.message_id;
  const seen = new Set<string>([item.message_id]);
  for (;;) {
    if (seen.has(id)) return id;
    seen.add(id);
    const next = byId.get(id)?.envelope.body.thread_root_id;
    if (!next) return id;
    id = next;
  }
}

function bySeq(a: HistoryItem, b: HistoryItem): number {
  const left = toSeq(a.room_seq);
  const right = toSeq(b.room_seq);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function replyCounts(items: HistoryItem[], byId: Map<string, HistoryItem>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (isTopLevel(item)) continue;
    const root = threadRootOf(item, byId);
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return counts;
}

export function threadReplies(items: HistoryItem[], byId: Map<string, HistoryItem>, rootId: string): HistoryItem[] {
  return items
    .filter((item) => !isTopLevel(item) && threadRootOf(item, byId) === rootId)
    .sort(bySeq);
}

// The ack route marks every delivery at or below the seq as read, so the client reports only a seq
// it has shown: the highest S such that every row at or below S is in the main timeline, an event,
// or in the open thread. useAck is forward-only, so closing a thread never lowers a reported seq.
export function ackWatermark(items: HistoryItem[], openRootId: string | null, byId: Map<string, HistoryItem>): string {
  let watermark = 0n;
  for (const item of [...items].sort(bySeq)) {
    const seen = isTopLevel(item) || (openRootId !== null && threadRootOf(item, byId) === openRootId);
    if (!seen) break;
    watermark = toSeq(item.room_seq);
  }
  return watermark.toString();
}
