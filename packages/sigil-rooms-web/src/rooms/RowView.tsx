import type { Row } from './mergeRows';

function Stamp({ at }: { at: string }) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return <time dateTime={at}>{date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>;
}

export function RowView({ row, sender, replies = 0, onReply }: { row: Row; sender: string | null; replies?: number; onReply?: () => void }) {
  if (row.pending) {
    return (
      <li data-mine="true" data-pending={row.pending.status}>
        <span className="text">{row.pending.text}</span>
        <em className="status">{row.pending.status === 'failed' ? `Failed: ${row.pending.error ?? 'send error'}` : 'Sending…'}</em>
      </li>
    );
  }
  const envelope = row.item!.envelope;
  if (envelope.message_type === 'room.event') {
    const { kind, reason } = envelope.body;
    return <li data-kind="event"><em>{kind}{reason ? `: ${reason}` : ''}</em></li>;
  }
  const mine = sender !== null && envelope.sender.endpoint_id === sender;
  return (
    <li data-mine={mine ? 'true' : undefined}>
      <div className="meta">
        <small className="sender">{envelope.sender.endpoint_id}</small>
        <Stamp at={envelope.created_at} />
      </div>
      <span className="text">{envelope.body.text}</span>
      {onReply ? (
        <div className="row-actions">
          <button type="button" className="ghost" onClick={onReply}>Reply</button>
          {replies > 0 ? (
            <button type="button" className="ghost" onClick={onReply}>{replies} {replies === 1 ? 'reply' : 'replies'}</button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
