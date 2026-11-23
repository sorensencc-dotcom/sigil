import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import type { HistoryItem, Member, RoomSearchItem } from '../api/types';
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
const SEARCH_RESULT_WINDOW_MAX = 100;

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
  const { items, isLoading, error, hasOlder, hasNewer, atLatest, loadOlder, loadNewer, goToLatest, goToSequence } = useHistory(roomId);
  const [focusedSeq, setFocusedSeq] = useState<string | null>(null);
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
    () => mergeRows(items.filter((item) => isTopLevel(item, byId) || String(item.room_seq) === focusedSeq), pending.filter((message) => !message.threadRootId), activity),
    [items, byId, pending, activity, focusedSeq],
  );
  const watermark = useMemo(() => ackWatermark(items, seenThreadRoots, byId), [items, seenThreadRoots, byId]);
  const savedWatermark = useMemo(() => readWatermark(roomId), [roomId]);
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
  const initialHistoryLoadRoom = useRef<string | null>(null);
  const [initialHistoryRoom, setInitialHistoryRoom] = useState<string | null>(null);
  const stickToBottom = useRef(true);
  const prependPosition = useRef<{ height: number; top: number } | null>(null);
  const loadingOlder = useRef(false);
  const pendingScrollSeq = useRef<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<RoomSearchItem[]>([]);
  const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<unknown>(null);

  useEffect(() => {
    if (isLoading || items.length === 0 || initialHistoryRoom === roomId || initialHistoryLoadRoom.current === roomId) return;
    if (savedWatermark !== null && BigInt(items[0]!.room_seq) > savedWatermark) {
      initialHistoryLoadRoom.current = roomId;
      void goToSequence(savedWatermark.toString()).then(
        () => setInitialHistoryRoom(roomId),
        (caught: unknown) => { setSearchError(caught); setInitialHistoryRoom(roomId); },
      );
    } else {
      setInitialHistoryRoom(roomId);
    }
  }, [goToSequence, initialHistoryRoom, isLoading, items, roomId, savedWatermark]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || initialHistoryRoom !== roomId) return;
    const previous = prependPosition.current;
    if (previous) {
      el.scrollTop = previous.top + (el.scrollHeight - previous.height);
      prependPosition.current = null;
    } else if (positionedRoom.current !== roomId) {
      positionedRoom.current = roomId;
      if (newDivider.current) {
        el.scrollTop = Math.max(0, newDivider.current.offsetTop - el.offsetTop);
        stickToBottom.current = false;
      } else {
        el.scrollTop = el.scrollHeight;
        stickToBottom.current = true;
      }
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    const target = pendingScrollSeq.current;
    if (target) {
      const row = el.querySelector<HTMLElement>(`[data-room-seq="${target}"]`);
      row?.scrollIntoView?.({ block: 'center' });
      pendingScrollSeq.current = null;
    }
    setShowJump(!stickToBottom.current || !atLatest);
  }, [initialHistoryRoom, roomId, items, entries.length, pending.length, atLatest]);

  useEffect(() => {
    const oldestSeq = items[0] ? BigInt(items[0].room_seq) : null;
    const coversSavedBoundary = savedWatermark === null ? !hasOlder : oldestSeq !== null && oldestSeq <= savedWatermark + 1n;
    const reportVisibleWatermark = () => {
      if (document.visibilityState !== 'visible' || watermark === '0' || !coversSavedBoundary) return;
      const computed = BigInt(watermark);
      const saved = readWatermark(roomId);
      const next = saved !== null && saved > computed ? saved : computed;
      onVisibleSeq(watermark);
      try {
        localStorage.setItem(`sigil.room:${roomId}:watermark`, next.toString());
      } catch {}
    };
    reportVisibleWatermark();
    document.addEventListener('visibilitychange', reportVisibleWatermark);
    return () => document.removeEventListener('visibilitychange', reportVisibleWatermark);
  }, [hasOlder, items, onVisibleSeq, roomId, savedWatermark, watermark]);

  useEffect(() => {
    if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone();
  }, [error, onGone]);

  if (error && items.length === 0) return <ErrorBanner error={error} />;
  if (isLoading) return <p>Loading messages…</p>;

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = searchText.trim();
    setSearchTerm(query);
    setSearchResults([]);
    setSearchCursor(null);
    setSearchHasMore(false);
    setSearchError(null);
    if (!query) return;
    setSearching(true);
    try {
      const page = await client.searchHistory(roomId, query);
      setSearchResults(page.items);
      setSearchCursor(page.next_before_seq == null ? null : String(page.next_before_seq));
      setSearchHasMore(page.has_more);
    } catch (caught) {
      setSearchError(caught);
    } finally {
      setSearching(false);
    }
  }

  async function loadMoreSearch() {
    if (!searchTerm || !searchCursor || searching) return;
    setSearching(true);
    setSearchError(null);
    try {
      const page = await client.searchHistory(roomId, searchTerm, searchCursor);
      setSearchResults((current) => [...current, ...page.items].slice(-SEARCH_RESULT_WINDOW_MAX));
      setSearchCursor(page.next_before_seq == null ? null : String(page.next_before_seq));
      setSearchHasMore(page.has_more);
    } catch (caught) {
      setSearchError(caught);
    } finally {
      setSearching(false);
    }
  }

  async function openSearchResult(item: RoomSearchItem) {
    const seq = String(item.room_seq);
    setFocusedSeq(seq);
    pendingScrollSeq.current = seq;
    stickToBottom.current = false;
    await goToSequence(seq);
  }

  async function fetchOlder() {
    const el = scroller.current;
    if (!el || loadingOlder.current || !hasOlder) return;
    loadingOlder.current = true;
    prependPosition.current = { height: el.scrollHeight, top: el.scrollTop };
    try { await loadOlder(); } finally { loadingOlder.current = false; }
  }

  async function jumpToLatest() {
    stickToBottom.current = true;
    await goToLatest();
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    setShowJump(false);
  }

  async function fetchNewer() {
    stickToBottom.current = true;
    await loadNewer();
  }

  return (
    <section
      aria-label="Messages"
      className="timeline"
      ref={scroller}
      onScroll={(event) => {
        const el = event.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        setShowJump(!stickToBottom.current || !atLatest);
        if (el.scrollTop < 48) void fetchOlder();
      }}
    >
      {error ? <ErrorBanner error={error} /> : null}
      <div className="timeline-tools">
        <form className="room-search" role="search" onSubmit={submitSearch}>
          <label htmlFor={`room-search-${roomId}`}>Find in room</label>
          <input id={`room-search-${roomId}`} aria-label="Find in room" value={searchText} onChange={(event) => setSearchText(event.currentTarget.value)} maxLength={100} />
          <button type="submit" disabled={searching || searchText.trim().length < 3}>Search</button>
        </form>
        <div className="history-controls">
          {hasOlder ? <button type="button" className="ghost" disabled={loadingOlder.current} onClick={() => void fetchOlder()}>Load older messages</button> : null}
          {hasNewer ? <button type="button" className="ghost" onClick={() => void fetchNewer()}>Load newer messages</button> : null}
        </div>
      </div>
      {searchError ? <ErrorBanner error={searchError} /> : null}
      {searchResults.length > 0 ? (
        <section aria-label="Search results" className="room-search-results">
          <h2>Results for “{searchTerm}”</h2>
          <ul>
            {searchResults.map((item) => (
              <li key={item.message_id}>
                <button type="button" onClick={() => void openSearchResult(item)}>
                  <span>{item.display_name || item.sender_endpoint_id} · {new Date(item.created_at).toLocaleString()}</span>
                  <span>{item.snippet}</span>
                </button>
              </li>
            ))}
          </ul>
          {searchHasMore ? <button type="button" className="ghost" disabled={searching} onClick={() => void loadMoreSearch()}>{searching ? 'Searching…' : 'More results'}</button> : null}
        </section>
        ) : searchTerm && !searching && !searchError ? <p className="room-search-empty">No messages found for “{searchTerm}”.</p> : null}
      {showJump || !atLatest ? <button className="timeline-jump" type="button" onClick={() => void jumpToLatest()}>Jump to latest</button> : null}
      <ul>
        {entries.map((entry) => entry.kind === 'day' ? (
          <li className="timeline-day" key={entry.key}><time>{entry.label}</time></li>
        ) : entry.kind === 'new' ? (
          <li className="timeline-divider" key="new" ref={newDivider}><span>New messages · this browser</span></li>
        ) : (
          <RowView
            key={entry.row.key}
            row={entry.row}
            roomId={roomId}
            sender={sender}
            nameFor={nameFor}
            loginFor={loginFor}
            ownerNameFor={ownerNameFor}
            members={members}
            replies={entry.row.item ? counts.get(entry.row.item.message_id) ?? 0 : 0}
            latestReplies={entry.row.item ? latestByRoot.get(entry.row.item.message_id) ?? [] : []}
            highlighted={entry.row.item != null && String(entry.row.item.room_seq) === focusedSeq}
            onContinue={(threadRootId) => { if (!resume.isPending) resume.mutate(threadRootId); }}
            onReply={entry.row.item && entry.row.item.envelope.message_type === 'room.message' ? () => onOpenThread(threadRootOf(entry.row.item!, byId)) : undefined}
          />
        ))}
      </ul>
    </section>
  );
}
