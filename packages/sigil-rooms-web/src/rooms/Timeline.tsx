import { useEffect, useMemo } from 'react';
import { ApiError } from '../api/client';
import { ErrorBanner } from '../errors/ErrorBanner';
import { getSender } from '../auth/tokenStore';
import { mergeRows, type PendingMessage, type Row } from './mergeRows';
import { maxSeq } from './seq';
import { useHistory } from './useHistory';

function RowView({ row, sender }: { row: Row; sender: string | null }) {
  if (row.pending) {
    return (
      <li data-pending={row.pending.status}>
        <span>{row.pending.text}</span> <em>{row.pending.status === 'failed' ? `Failed: ${row.pending.error ?? 'send error'}` : 'Sending…'}</em>
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
      <small>{envelope.sender.endpoint_id}</small>
      <span>{envelope.body.text}</span>
    </li>
  );
}

export function Timeline({ roomId, pending, onVisibleSeq, onGone }: { roomId: string; pending: PendingMessage[]; onVisibleSeq: (seq: string) => void; onGone: () => void }) {
  const { items, isLoading, error } = useHistory(roomId);
  const rows = useMemo(() => mergeRows(items, pending), [items, pending]);
  const highest = useMemo(() => maxSeq(items.map((item) => item.room_seq)), [items]);

  useEffect(() => {
    if (highest !== '0') onVisibleSeq(highest);
  }, [highest, onVisibleSeq]);

  useEffect(() => {
    if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone();
  }, [error, onGone]);

  if (error && items.length === 0) return <ErrorBanner error={error} />;
  if (isLoading) return <p>Loading messages…</p>;
  const sender = getSender();
  return (
    <section aria-label="Messages">
      {error ? <ErrorBanner error={error} /> : null}
      <ul>
        {rows.map((row) => (
          <RowView key={row.key} row={row} sender={sender} />
        ))}
      </ul>
    </section>
  );
}
