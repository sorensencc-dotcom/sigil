import { useEffect, useState } from 'react';
import type { RoomApproval } from '../api/client';
import { formatCountdown, shownOutcome, type HoldOutcome, type HoldState } from './holds';

const OUTCOME_LABEL: Record<HoldOutcome, string> = {
  granted: 'Approved',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

// A clock that ticks once a second while something on screen counts down, and not otherwise.
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function capabilityText(state: Pick<HoldState, 'reason'>, approval: RoomApproval | null): string {
  const names = approval?.capabilities?.length ? approval.capabilities.join(', ') : state.reason;
  return names || 'a high-risk action';
}

// The hold's row in the timeline (#269). While pending: who needs approval, for what, who it
// waits on, and how long is left; only the approver gets the link to the relay's approval page.
// After it ends: one muted line from the signed outcome event.
export function ApprovalCard({ state, senderName, now, roomSeq }: { state: HoldState; senderName: string; now: number; roomSeq?: string }) {
  const outcome = shownOutcome(state, now);
  const { approval } = state;
  if (outcome) {
    return (
      <li data-kind="event" data-hold={outcome} data-room-seq={roomSeq}>
        <em>
          {senderName}’s held message: {OUTCOME_LABEL[outcome]}
          {outcome === 'granted' ? <> · <a href={`#message-${state.heldMessageId}`}>View message</a></> : null}
        </em>
      </li>
    );
  }
  const expires = approval?.expires_at ? Date.parse(approval.expires_at) : NaN;
  return (
    <li className="approval-card" data-trust="held" data-hold="pending" data-room-seq={roomSeq}>
      <strong>{senderName} needs approval</strong>
      <span>
        {capabilityText(state, approval)}
        {approval ? ` · Waiting for ${approval.approver_name}` : null}
      </span>
      {Number.isNaN(expires) ? null : (
        <time dateTime={approval!.expires_at!} aria-label={`Expires in ${formatCountdown(expires - now)}`}>Expires in {formatCountdown(expires - now)}</time>
      )}
      {approval?.approval_url ? (
        <a href={approval.approval_url} target="_blank" rel="noreferrer">Approve on the relay page (opens in a new tab)</a>
      ) : null}
    </li>
  );
}

// A pending hold whose request event isn't in the loaded history: same card, after the rows.
export function UnplacedApprovalCard({ approval, senderName, now }: { approval: RoomApproval; senderName: string; now: number }) {
  const state: HoldState = {
    eventId: approval.message_id ?? approval.approval_url ?? '',
    heldMessageId: approval.message_id ?? '',
    senderEndpointId: approval.sender_endpoint_id ?? '',
    reason: '',
    outcome: null,
    approval,
  };
  if (!approval.message_id && !approval.sender_endpoint_id) {
    // A relay that predates #269 sends only the approver and the link.
    return (
      <li className="approval-card" data-trust="held" data-hold="pending">
        <strong>Approval required</strong>
        <span>Waiting for {approval.approver_name}</span>
        {approval.approval_url ? <a href={approval.approval_url} target="_blank" rel="noreferrer">Approve on the relay page (opens in a new tab)</a> : null}
      </li>
    );
  }
  return <ApprovalCard state={state} senderName={senderName} now={now} />;
}
