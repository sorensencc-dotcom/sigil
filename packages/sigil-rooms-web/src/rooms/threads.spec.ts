import { describe, expect, it } from 'vitest';
import type { HistoryItem } from '../api/types';
import { ackWatermark, isReply, isTopLevel, replyCounts, rowsById, threadReplies, threadRootOf } from './threads';

function row(seq: number, id: string, opts: { root?: string; type?: string } = {}): HistoryItem {
  const type = opts.type ?? 'room.message';
  return {
    room_seq: String(seq),
    message_id: id,
    canonical_bytes: 'b',
    envelope: {
      message_id: id,
      message_type: type,
      sender: { endpoint_id: 'ep_a', owner_id: 'u' },
      body: type === 'room.event' ? { kind: 'invocation_stopped' } : { text: id, ...(opts.root ? { thread_root_id: opts.root } : {}) },
      created_at: 't',
    },
  };
}

describe('threadRootOf', () => {
  it('returns the message itself for a top-level row', () => {
    const items = [row(1, 'a')];
    expect(threadRootOf(items[0]!, rowsById(items))).toBe('a');
  });

  it('returns the root of a direct reply', () => {
    const items = [row(1, 'a'), row(2, 'b', { root: 'a' })];
    expect(threadRootOf(items[1]!, rowsById(items))).toBe('a');
  });

  it('follows a depth-2 chain to the top root', () => {
    const items = [row(1, 'a'), row(2, 'b', { root: 'a' }), row(3, 'c', { root: 'b' })];
    expect(threadRootOf(items[2]!, rowsById(items))).toBe('a');
  });

  it('returns the named root when that row is not loaded', () => {
    const items = [row(5, 'c', { root: 'missing' })];
    expect(threadRootOf(items[0]!, rowsById(items))).toBe('missing');
  });

  it('stops on a cycle instead of looping', () => {
    const items = [row(1, 'x', { root: 'y' }), row(2, 'y', { root: 'x' })];
    expect(['x', 'y']).toContain(threadRootOf(items[0]!, rowsById(items)));
  });
});

describe('isReply and isTopLevel', () => {
  it('isReply is true only for a message that names a thread root', () => {
    expect(isReply(row(1, 'a'))).toBe(false);
    expect(isReply(row(2, 'b', { root: 'a' }))).toBe(true);
    expect(isReply(row(3, 'e', { type: 'room.event' }))).toBe(false);
  });

  it('hides a reply whose root is loaded', () => {
    const items = [row(1, 'a'), row(2, 'b', { root: 'a' }), row(3, 'e', { type: 'room.event' })];
    const byId = rowsById(items);
    expect(items.map((i) => isTopLevel(i, byId))).toEqual([true, false, true]);
  });

  it('keeps a reply top-level when its canonical root is not loaded', () => {
    const items = [row(1, 'orphan', { root: 'gone' }), row(2, 'child', { root: 'orphan' })];
    const byId = rowsById(items);
    expect(items.map((i) => isTopLevel(i, byId))).toEqual([true, true]);
  });
});

describe('replyCounts and threadReplies', () => {
  const items = [row(1, 'a'), row(2, 'b', { root: 'a' }), row(3, 'c', { root: 'b' }), row(4, 'd'), row(5, 'e', { root: 'a' })];
  const byId = rowsById(items);

  it('counts replies per canonical root, nested replies included', () => {
    expect(replyCounts(items, byId).get('a')).toBe(3);
    expect(replyCounts(items, byId).has('d')).toBe(false);
  });

  it('lists a thread\'s replies in room_seq order without the root', () => {
    expect(threadReplies(items, byId, 'a').map((i) => i.message_id)).toEqual(['b', 'c', 'e']);
  });

  it('lists the replies of a root that is not loaded', () => {
    const orphan = [row(9, 'z', { root: 'gone' })];
    expect(threadReplies(orphan, rowsById(orphan), 'gone').map((i) => i.message_id)).toEqual(['z']);
  });

  it('puts out-of-order rows in room_seq order', () => {
    const shuffled = [row(5, 'e', { root: 'a' }), row(1, 'a'), row(2, 'b', { root: 'a' })];
    expect(threadReplies(shuffled, rowsById(shuffled), 'a').map((i) => i.message_id)).toEqual(['b', 'e']);
  });
});

describe('ackWatermark', () => {
  const none = new Set<string>();
  const items = [row(1, 'm1'), row(2, 'r2', { root: 'm1' }), row(3, 'm3')];
  const byId = rowsById(items);

  it('stops before an unseen reply in a never-opened thread', () => {
    expect(ackWatermark(items, none, byId)).toBe('1');
  });

  it('reaches the highest seq once the thread has been opened', () => {
    expect(ackWatermark(items, new Set(['m1']), byId)).toBe('3');
  });

  it('keeps advancing after the thread is closed when new rows arrive', () => {
    const seen = new Set(['m1']);
    const more = [...items, row(4, 'm4')];
    expect(ackWatermark(more, seen, rowsById(more))).toBe('4');
  });

  it('stalls at the row before the first reply of a thread that was never opened', () => {
    const two = [row(1, 'a'), row(2, 'ra', { root: 'a' }), row(3, 'b'), row(4, 'rb', { root: 'b' }), row(5, 'c')];
    expect(ackWatermark(two, new Set(['a']), rowsById(two))).toBe('3');
  });

  it('is the highest seq when every row is top-level, events included', () => {
    const flat = [row(1, 'a'), row(2, 'e', { type: 'room.event' }), row(3, 'b')];
    expect(ackWatermark(flat, none, rowsById(flat))).toBe('3');
  });

  it('does not stall on a reply whose root is not loaded', () => {
    const orphan = [row(1, 'r', { root: 'gone' }), row(2, 'm')];
    expect(ackWatermark(orphan, none, rowsById(orphan))).toBe('2');
  });

  it('counts a depth-2 reply as seen when its canonical root was opened', () => {
    const nested = [row(1, 'a'), row(2, 'b', { root: 'a' }), row(3, 'c', { root: 'b' })];
    expect(ackWatermark(nested, new Set(['a']), rowsById(nested))).toBe('3');
    expect(ackWatermark(nested, none, rowsById(nested))).toBe('1');
  });

  it('is 0 for no rows', () => {
    expect(ackWatermark([], none, new Map())).toBe('0');
  });
});
