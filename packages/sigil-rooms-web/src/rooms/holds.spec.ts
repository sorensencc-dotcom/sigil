import { describe, expect, it } from 'vitest';
import type { RoomApproval } from '../api/client';
import type { HistoryItem } from '../api/types';
import { formatCountdown, indexHolds, isHoldEvent, isPendingHold, shownOutcome } from './holds';

function hold(seq: number, kind: string, held: string): HistoryItem {
  const id = `e${seq}`;
  return {
    room_seq: String(seq), message_id: id, canonical_bytes: 'b',
    envelope: { message_id: id, message_type: 'room.event', sender: { endpoint_id: 'ep_relay_system', owner_id: 'relay_system' }, body: { kind, endpoint_ids: ['ep_claude'], held_message_id: held, reason: 'payments.send' }, created_at: '2026-11-28T12:00:00.000Z' },
  };
}
const approval = (messageId: string, extra: Partial<RoomApproval> = {}): RoomApproval => ({
  approver_name: 'Chris', approval_url: null, challenge_id: null, message_id: messageId, sender_endpoint_id: 'ep_claude', sender_name: 'Claude',
  capabilities: ['payments.send'], created_at: '2026-11-28T12:00:00.000Z', expires_at: '2026-11-28T12:05:00.000Z', ...extra,
});

describe('indexHolds', () => {
  it('folds an outcome into its request row and pairs a pending request with its approvals item', () => {
    const items = [hold(1, 'approval_requested', 'msg_a'), hold(2, 'approval_granted', 'msg_a'), hold(3, 'approval_requested', 'msg_b')];
    const index = indexHolds(items, [approval('msg_b')]);
    expect(index.byEvent.get('e1')).toMatchObject({ outcome: 'granted', heldMessageId: 'msg_a', senderEndpointId: 'ep_claude' });
    expect(index.folded).toEqual(new Set(['e2']));
    expect(index.byEvent.get('e3')).toMatchObject({ outcome: null, approval: { message_id: 'msg_b' } });
    expect(index.unplaced).toEqual([]);
  });

  it('gives a message held twice one row per hold, the live one paired with the approvals item', () => {
    const items = [hold(1, 'approval_requested', 'msg_a'), hold(2, 'approval_cancelled', 'msg_a'), hold(3, 'approval_requested', 'msg_a')];
    const index = indexHolds(items, [approval('msg_a')]);
    expect(index.byEvent.get('e1')?.outcome).toBe('cancelled');
    expect(index.byEvent.get('e1')?.approval).toBeNull();
    expect(index.byEvent.get('e3')?.approval?.message_id).toBe('msg_a');
  });

  it('shows an outcome whose request is outside the window, and a pending hold with no request row', () => {
    const index = indexHolds([hold(9, 'approval_expired', 'msg_old')], [approval('msg_new')]);
    expect(index.orphanOutcomes.get('e9')).toMatchObject({ outcome: 'expired', heldMessageId: 'msg_old' });
    expect(index.unplaced.map((item) => item.message_id)).toEqual(['msg_new']);
  });

  it('keeps the last approvals item for a hold that just left the list', () => {
    const last = new Map([['msg_a', approval('msg_a')]]);
    const index = indexHolds([hold(1, 'approval_requested', 'msg_a')], [], last);
    expect(index.byEvent.get('e1')?.approval?.expires_at).toBe('2026-11-28T12:05:00.000Z');
  });

  it('recognises only the four hold kinds', () => {
    expect(isHoldEvent(hold(1, 'approval_requested', 'm'))).toBe(true);
    expect(isHoldEvent(hold(1, 'approval_expired', 'm'))).toBe(true);
    expect(isHoldEvent(hold(1, 'invocation_stopped', 'm'))).toBe(false);
  });
});

describe('hold clock', () => {
  it('flips a pending hold to expired at expires_at', () => {
    const state = indexHolds([hold(1, 'approval_requested', 'msg_a')], [approval('msg_a')]).byEvent.get('e1')!;
    const expires = Date.parse('2026-11-28T12:05:00.000Z');
    expect(isPendingHold(state, expires - 1)).toBe(true);
    expect(shownOutcome(state, expires - 1)).toBeNull();
    expect(isPendingHold(state, expires)).toBe(false);
    expect(shownOutcome(state, expires)).toBe('expired');
  });

  it('formats the countdown', () => {
    expect(formatCountdown(299_500)).toBe('5:00');
    expect(formatCountdown(61_000)).toBe('1:01');
    expect(formatCountdown(-5)).toBe('0:00');
    expect(formatCountdown(2 * 3600_000 + 3 * 60_000)).toBe('2h 3m');
  });
});
