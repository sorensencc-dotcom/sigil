import { describe, expect, it } from 'vitest';
import type { HistoryItem } from '../api/types';
import { mergeRows, type PendingMessage } from './mergeRows';

function item(seq: string | number, id: string, text = 'x'): HistoryItem {
  return {
    room_seq: seq,
    message_id: id,
    canonical_bytes: 'b',
    envelope: { message_id: id, message_type: 'room.message', sender: { endpoint_id: 'ep_web', owner_id: 'u' }, body: { text }, created_at: '2026-10-07T00:00:00Z' },
  };
}

describe('mergeRows', () => {
  it('sorts by room_seq and dedupes duplicate sequences', () => {
    const rows = mergeRows([item('3', 'm3'), item(1, 'm1'), item('3', 'm3'), item('2', 'm2')], []);
    expect(rows.map((r) => r.key)).toEqual(['seq:1', 'seq:2', 'seq:3']);
  });

  it('tolerates out-of-order pages', () => {
    const rows = mergeRows([item('5', 'm5'), item('4', 'm4')], []);
    expect(rows.map((r) => r.seq)).toEqual([4n, 5n]);
  });

  it('appends pending rows after history', () => {
    const pending: PendingMessage[] = [{ idempotencyKey: 'k1', text: 'hello', status: 'sending' }];
    const rows = mergeRows([item(1, 'm1')], pending);
    expect(rows.map((r) => r.key)).toEqual(['seq:1', 'pending:k1']);
    expect(rows[1]!.pending?.status).toBe('sending');
  });

  it('drops a pending row once history holds its message_id', () => {
    const pending: PendingMessage[] = [{ idempotencyKey: 'k1', text: 'hello', status: 'sending', messageId: 'm2' }];
    const rows = mergeRows([item(1, 'm1'), item(2, 'm2')], pending);
    expect(rows.map((r) => r.key)).toEqual(['seq:1', 'seq:2']);
  });

  it('keeps a failed pending row', () => {
    const pending: PendingMessage[] = [{ idempotencyKey: 'k1', text: 'hello', status: 'failed', error: 'boom' }];
    expect(mergeRows([], pending)[0]!.pending).toMatchObject({ status: 'failed', error: 'boom' });
  });
});
