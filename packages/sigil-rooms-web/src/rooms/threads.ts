import type { HistoryItem } from '../api/types';
import { toSeq } from './seq';

export function rowsById(items: HistoryItem[]): Map<string, HistoryItem> {
  return new Map(items.map((item) => [item.message_id, item]));
}

// A reply is a room.message that names a thread root.
export function isReply(item: HistoryItem): boolean {
  return item.envelope.message_type === 'room.message' && Boolean(item.envelope.body.thread_root_id);
}

// Main-timeline rows: events, plain messages, and replies whose canonical root is not loaded
// (no root row exists to open them from, so hiding them would drop them).
export function isTopLevel(item: HistoryItem, byId: Map<string, HistoryItem>): boolean {
  return !isReply(item) || !byId.has(threadRootOf(item, byId));
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
    if (!isReply(item)) continue;
    const root = threadRootOf(item, byId);
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return counts;
}

export function threadReplies(items: HistoryItem[], byId: Map<string, HistoryItem>, rootId: string): HistoryItem[] {
  return items
    .filter((item) => isReply(item) && threadRootOf(item, byId) === rootId)
    .sort(bySeq);
}

// The ack route marks every delivery at or below the seq as read, so the client reports only a seq
// it has shown: the highest S such that every row at or below S is in the main timeline, an event,
// or in a thread the user has opened. seenRoots only grows, so closing a thread keeps its rows seen.
export function ackWatermark(items: HistoryItem[], seenRoots: ReadonlySet<string>, byId: Map<string, HistoryItem>): string {
  let watermark = 0n;
  for (const item of [...items].sort(bySeq)) {
    const seen = isTopLevel(item, byId) || seenRoots.has(threadRootOf(item, byId));
    if (!seen) break;
    watermark = toSeq(item.room_seq);
  }
  return watermark.toString();
}
