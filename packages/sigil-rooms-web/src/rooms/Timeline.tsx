import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import type { HistoryItem, Member, RoomSearchItem } from '../api/types';
import { ErrorBanner } from '../errors/ErrorBanner';
import { useAuth, useSelfEndpoint } from '../auth/AuthContext';
import { mergeRows, type PendingMessage } from './mergeRows';
import { RowView } from './RowView';
import { ackWatermark, isTopLevel, lastActivitySeq, latestReplies, replyCounts, rowsById, threadRootOf } from './threads';
import { historyKey } from './historyQuery';
import { useHistory } from './useHistory';
import type { LoginFor, NameFor, OwnerNameFor } from './useContacts';

const NO_ROOTS: ReadonlySet<string> = new Set();
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

  const scroller = useRef<HTMLElement>(null);
  const stickToBottom = useRef(true);
  const prependPosition = useRef<{ height: number; top: number } | null>(null);
  const loadingOlder = useRef(false);
  const pendingScrollSeq = useRef<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<RoomSearchItem[]>([]);
  const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<unknown>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const previous = prependPosition.current;
    if (previous) {
      el.scrollTop = previous.top + (el.scrollHeight - previous.height);
      prependPosition.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    const target = pendingScrollSeq.current;
    if (target) {
      const row = el.querySelector<HTMLElement>(`[data-room-seq="${target}"]`);
      row?.scrollIntoView?.({ block: 'center' });
      pendingScrollSeq.current = null;
    }
  }, [items, pending.length]);

  useEffect(() => {
    if (watermark !== '0') onVisibleSeq(watermark);
  }, [watermark, onVisibleSeq]);

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
          {!atLatest ? <button type="button" className="ghost" onClick={() => void jumpToLatest()}>Jump to latest</button> : null}
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
      <ul>
        {rows.map((row) => (
          <RowView
            key={row.key}
            roomId={roomId}
            row={row}
            sender={sender}
            nameFor={nameFor}
            loginFor={loginFor}
            ownerNameFor={ownerNameFor}
            members={members}
            replies={row.item ? counts.get(row.item.message_id) ?? 0 : 0}
            latestReplies={row.item ? latestByRoot.get(row.item.message_id) ?? [] : []}
            highlighted={row.item != null && String(row.item.room_seq) === focusedSeq}
            onContinue={(threadRootId) => { if (!resume.isPending) resume.mutate(threadRootId); }}
            onReply={row.item && row.item.envelope.message_type === 'room.message' ? () => onOpenThread(threadRootOf(row.item!, byId)) : undefined}
          />
        ))}
      </ul>
    </section>
  );
}
