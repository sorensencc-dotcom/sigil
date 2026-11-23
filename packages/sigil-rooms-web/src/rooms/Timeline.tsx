import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import type { HistoryItem, Member } from '../api/types';
import { ErrorBanner } from '../errors/ErrorBanner';
import { useAuth, useSelfEndpoint } from '../auth/AuthContext';
import { mergeRows, type PendingMessage, type Row } from './mergeRows';
import { RowView } from './RowView';
import { ackWatermark, isTopLevel, lastActivitySeq, latestReplies, replyCounts, rowsById, threadRootOf } from './threads';
import { historyKey } from './historyQuery';
import { useHistory } from './useHistory';
import type { LoginFor, NameFor, OwnerNameFor } from './useContacts';

const NO_ROOTS: ReadonlySet<string> = new Set();
type TimelineEntry = { kind: 'row'; row: Row } | { kind: 'day'; key: string; label: string } | { kind: 'new' };

function readWatermark(roomId: string): bigint | null {
  try {
    const value = localStorage.getItem(`sigil.room:${roomId}:watermark`);
    if (value === null) return null;
    const seq = BigInt(value);
    return seq >= 0n ? seq : null;
  } catch {
    return null;
  }
}

export function Timeline({
  roomId,
  pending,
  onVisibleSeq,
  onGone,
  seenThreadRoots = NO_ROOTS,
  onOpenThread = () => {},
  nameFor,
  loginFor,
  ownerNameFor,
  members = [],
}: {
  roomId: string;
  pending: PendingMessage[];
  onVisibleSeq: (seq: string) => void;
  onGone: () => void;
  seenThreadRoots?: ReadonlySet<string>;
  onOpenThread?: (rootId: string) => void;
  nameFor?: NameFor;
  loginFor?: LoginFor;
  ownerNameFor?: OwnerNameFor;
  members?: Member[];
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
  const latestByRoot = useMemo(() => {
    const map = new Map<string, HistoryItem[]>();
    for (const rootId of counts.keys()) {
      map.set(rootId, latestReplies(items, byId, rootId));
    }
    return map;
  }, [items, byId, counts]);
  const activity = useMemo(() => lastActivitySeq(items, byId), [items, byId]);
  const rows = useMemo(
    () => mergeRows(items.filter((item) => isTopLevel(item, byId)), pending.filter((message) => !message.threadRootId), activity),
    [items, byId, pending, activity],
  );
  const watermark = useMemo(() => ackWatermark(items, seenThreadRoots, byId), [items, seenThreadRoots, byId]);
  const [savedWatermark] = useState(() => readWatermark(roomId));
  const entries = useMemo(() => {
    const result: TimelineEntry[] = [];
    let previousDay: string | null = null;
    let addedNewDivider = false;
    for (const row of rows) {
      if (row.item) {
        const replies = latestByRoot.get(row.item.message_id) ?? [];
        const latestActivity = replies[replies.length - 1] ?? row.item;
        const createdAt = new Date(latestActivity.envelope.created_at);
        const date = `${createdAt.getFullYear()}-${createdAt.getMonth()}-${createdAt.getDate()}`;
        if (date !== previousDay) {
          result.push({ kind: 'day', key: `day:${row.key}`, label: createdAt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) });
          previousDay = date;
        }
        const activitySeq = activity.get(row.item.message_id) ?? row.seq!;
        if (!addedNewDivider && savedWatermark !== null && activitySeq > savedWatermark) {
          result.push({ kind: 'new' });
          addedNewDivider = true;
        }
      }
      result.push({ kind: 'row', row });
    }
    return result;
  }, [rows, activity, latestByRoot, savedWatermark]);

  const scroller = useRef<HTMLElement>(null);
  const newDivider = useRef<HTMLLIElement>(null);
  const positionedRoom = useRef<string | null>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (positionedRoom.current !== roomId) {
      positionedRoom.current = roomId;
      if (newDivider.current) {
        el.scrollTop = Math.max(0, newDivider.current.offsetTop - el.offsetTop);
        atBottom.current = false;
        setShowJump(true);
      } else {
        el.scrollTop = el.scrollHeight;
        atBottom.current = true;
        setShowJump(false);
      }
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [roomId, entries.length, items.length, pending.length]);

  useEffect(() => {
    if (watermark === '0') return;
    onVisibleSeq(watermark);
    try {
      localStorage.setItem(`sigil.room:${roomId}:watermark`, watermark);
    } catch {}
  }, [roomId, watermark, onVisibleSeq]);

  useEffect(() => {
    if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone();
  }, [error, onGone]);

  if (error && items.length === 0) return <ErrorBanner error={error} />;
  if (isLoading) return <p>Loading messages…</p>;
  return (
    <section aria-label="Messages" className="timeline" ref={scroller} onScroll={() => {
      const el = scroller.current;
      if (!el) return;
      const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
      atBottom.current = isAtBottom;
      setShowJump(!isAtBottom);
    }}>
      {error ? <ErrorBanner error={error} /> : null}
      {showJump ? <button className="timeline-jump" type="button" onClick={() => {
        const el = scroller.current;
        if (el) el.scrollTop = el.scrollHeight;
        atBottom.current = true;
        setShowJump(false);
      }}>Jump to latest</button> : null}
      <ul>
        {entries.map((entry) => entry.kind === 'day' ? (
          <li className="timeline-day" key={entry.key}><time>{entry.label}</time></li>
        ) : entry.kind === 'new' ? (
          <li className="timeline-divider" key="new" ref={newDivider}><span>New messages · this browser</span></li>
        ) : (
          <RowView
            key={entry.row.key}
            row={entry.row}
            sender={sender}
            nameFor={nameFor}
            loginFor={loginFor}
            ownerNameFor={ownerNameFor}
            members={members}
            replies={entry.row.item ? counts.get(entry.row.item.message_id) ?? 0 : 0}
            latestReplies={entry.row.item ? latestByRoot.get(entry.row.item.message_id) ?? [] : []}
            onContinue={(threadRootId) => { if (!resume.isPending) resume.mutate(threadRootId); }}
            onReply={entry.row.item && entry.row.item.envelope.message_type === 'room.message' ? () => onOpenThread(threadRootOf(entry.row.item!, byId)) : undefined}
          />
        ))}
      </ul>
    </section>
  );
}
