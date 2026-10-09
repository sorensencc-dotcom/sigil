import { useEffect, useMemo, useRef } from 'react';
import { ApiError } from '../api/client';
import { ErrorBanner } from '../errors/ErrorBanner';
import { getSender } from '../auth/tokenStore';
import { mergeRows, type PendingMessage } from './mergeRows';
import { RowView } from './RowView';
import { ackWatermark, isTopLevel, replyCounts, rowsById, threadRootOf } from './threads';
import { useHistory } from './useHistory';

const NO_ROOTS: ReadonlySet<string> = new Set();

export function Timeline({
  roomId,
  pending,
  onVisibleSeq,
  onGone,
  seenThreadRoots = NO_ROOTS,
  onOpenThread = () => {},
}: {
  roomId: string;
  pending: PendingMessage[];
  onVisibleSeq: (seq: string) => void;
  onGone: () => void;
  seenThreadRoots?: ReadonlySet<string>;
  onOpenThread?: (rootId: string) => void;
}) {
  const { items, isLoading, error } = useHistory(roomId);
  const byId = useMemo(() => rowsById(items), [items]);
  const counts = useMemo(() => replyCounts(items, byId), [items, byId]);
  const rows = useMemo(
    () => mergeRows(items.filter((item) => isTopLevel(item, byId)), pending.filter((message) => !message.threadRootId)),
    [items, byId, pending],
  );
  const watermark = useMemo(() => ackWatermark(items, seenThreadRoots, byId), [items, seenThreadRoots, byId]);

  const scroller = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  useEffect(() => {
    if (watermark !== '0') onVisibleSeq(watermark);
  }, [watermark, onVisibleSeq]);

  useEffect(() => {
    if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone();
  }, [error, onGone]);

  if (error && items.length === 0) return <ErrorBanner error={error} />;
  if (isLoading) return <p>Loading messages…</p>;
  const sender = getSender();
  return (
    <section aria-label="Messages" className="timeline" ref={scroller}>
      {error ? <ErrorBanner error={error} /> : null}
      <ul>
        {rows.map((row) => (
          <RowView
            key={row.key}
            row={row}
            sender={sender}
            replies={row.item ? counts.get(row.item.message_id) ?? 0 : 0}
            onReply={row.item && row.item.envelope.message_type === 'room.message' ? () => onOpenThread(threadRootOf(row.item!, byId)) : undefined}
          />
        ))}
      </ul>
    </section>
  );
}
