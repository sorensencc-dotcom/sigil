import type { RoomApproval } from '../api/client';
import type { HistoryItem } from '../api/types';

// Rooms #269: pairs the relay-signed hold events in the loaded history with the pending holds
// from GET /v1/rooms/:id/approvals. Pure, so Timeline and its tests share one rule.
//
// The approval_requested event is the hold's row: it renders as the card while the hold is
// pending and as its outcome line after. The matching granted, cancelled or expired event is
// folded into that row, so a hold shows once. An outcome whose request is outside the loaded
// window still shows, on its own row.

export type HoldOutcome = 'granted' | 'cancelled' | 'expired';

export interface HoldState {
  // Id of the approval_requested event that stands for this hold.
  eventId: string;
  heldMessageId: string;
  senderEndpointId: string;
  // Capability names, from the event's reason or the approvals item.
  reason: string;
  outcome: HoldOutcome | null;
  // The approvals item while the hold is pending, or the last one seen for it.
  approval: RoomApproval | null;
}

export interface HoldIndex {
  // By approval_requested event id.
  byEvent: Map<string, HoldState>;
  // Outcome events already shown on their request's row.
  folded: Set<string>;
  // Outcome events with no request in the loaded window.
  orphanOutcomes: Map<string, HoldState>;
  // Pending holds with no request event in the loaded window (an older relay, or history not
  // loaded that far). These still show, after the timeline, as before.
  unplaced: RoomApproval[];
}

const OUTCOME_BY_KIND: Record<string, HoldOutcome> = {
  approval_granted: 'granted',
  approval_cancelled: 'cancelled',
  approval_expired: 'expired',
};

export function isHoldEvent(item: HistoryItem): boolean {
  const kind = item.envelope.message_type === 'room.event' ? item.envelope.body.kind : undefined;
  return kind === 'approval_requested' || (kind !== undefined && kind in OUTCOME_BY_KIND);
}

export function indexHolds(items: readonly HistoryItem[], approvals: readonly RoomApproval[], lastSeen: ReadonlyMap<string, RoomApproval> = new Map()): HoldIndex {
  const byEvent = new Map<string, HoldState>();
  const folded = new Set<string>();
  const orphanOutcomes = new Map<string, HoldState>();
  // Open requests per held message, oldest first. A message held twice has two.
  const open = new Map<string, HoldState[]>();
  for (const item of items) {
    const { envelope } = item;
    if (envelope.message_type !== 'room.event') continue;
    const { kind, held_message_id: heldMessageId, endpoint_ids: endpointIds = [], reason = '' } = envelope.body;
    if (!heldMessageId || !kind) continue;
    if (kind === 'approval_requested') {
      const state: HoldState = { eventId: item.message_id, heldMessageId, senderEndpointId: endpointIds[0] ?? '', reason, outcome: null, approval: null };
      byEvent.set(item.message_id, state);
      open.set(heldMessageId, [...(open.get(heldMessageId) ?? []), state]);
      continue;
    }
    const outcome = OUTCOME_BY_KIND[kind];
    if (!outcome) continue;
    const waiting = open.get(heldMessageId) ?? [];
    const request = waiting.shift();
    if (request) {
      request.outcome = outcome;
      folded.add(item.message_id);
    } else {
      orphanOutcomes.set(item.message_id, { eventId: item.message_id, heldMessageId, senderEndpointId: endpointIds[0] ?? '', reason, outcome, approval: null });
    }
  }
  const unplaced: RoomApproval[] = [];
  const placed = new Set<string>();
  for (const approval of approvals) {
    const waiting = approval.message_id ? open.get(approval.message_id) : undefined;
    // The newest open request is the live hold; any older open one ended outside the window.
    const request = waiting?.[waiting.length - 1];
    if (request && !request.approval) {
      request.approval = approval;
      placed.add(request.eventId);
    } else {
      unplaced.push(approval);
    }
  }
  // A hold that just left the approvals list but whose outcome event hasn't loaded yet keeps the
  // last item seen for it, so its countdown still runs and flips to Expired on time.
  for (const states of open.values()) {
    for (const state of states) {
      if (!placed.has(state.eventId)) state.approval = lastSeen.get(state.heldMessageId) ?? null;
    }
  }
  return { byEvent, folded, orphanOutcomes, unplaced };
}

// True while the hold still needs someone: no outcome event, and not past its expiry on this
// clock. The card flips to Expired at expires_at without waiting for the relay's sweep.
export function isPendingHold(state: HoldState, now: number): boolean {
  if (state.outcome) return false;
  const expires = state.approval?.expires_at ? Date.parse(state.approval.expires_at) : NaN;
  return Number.isNaN(expires) || now < expires;
}

export function shownOutcome(state: HoldState, now: number): HoldOutcome | null {
  if (state.outcome) return state.outcome;
  return isPendingHold(state, now) ? null : 'expired';
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
