import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { ApiError } from '../api/client';
import { ErrorBanner } from '../errors/ErrorBanner';
import { useAuth, useSelfEndpoint } from '../auth/AuthContext';
import { mergeRows, type PendingMessage } from './mergeRows';
import { RowView } from './RowView';
import { ackWatermark, isTopLevel, replyCounts, rowsById, threadRootOf } from './threads';
import { historyKey } from './historyQuery';
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
  const sender = useSelfEndpoint();
  const { client } = useAuth();
  const queryClient = useQueryClient();
  // 409 NOTHING_TO_CONTINUE means another click or client already resumed the thread; the refetch shows it.
  const resume = useMutation({
    mutationFn: (threadRootId: string) => client.continueThread(roomId, threadRootId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: historyKey(roomId) }),
  });
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
            onContinue={(threadRootId) => { if (!resume.isPending) resume.mutate(threadRootId); }}
            onReply={row.item && row.item.envelope.message_type === 'room.message' ? () => onOpenThread(threadRootOf(row.item!, byId)) : undefined}
          />
        ))}
      </ul>
    </section>
  );
}
