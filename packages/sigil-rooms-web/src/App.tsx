import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from './api/client';
import type { HistoryItem } from './api/types';
import { AuthProvider, useAuth, useSelfEndpoint } from './auth/AuthContext';
import { getSender } from './auth/tokenStore';
import { Mark, normalizeTheme, ThemeToggle } from './auth/GateHeader';
import { TokenGate } from './auth/TokenGate';
import { loadConfig, type WebConfig } from './config';
import { describeError, ErrorBanner } from './errors/ErrorBanner';
import { useLive } from './live/useLive';
import { captureInviteFragment, InvitePage } from './pages/InvitePage';
import { LoginPage } from './pages/LoginPage';
import { MentionsView } from './pages/MentionsView';
import { SettingsPage } from './pages/SettingsPage';
import type { Mention } from './api/types';
import { Composer } from './rooms/Composer';
import { DensityToggle } from './rooms/DensityToggle';
import { VerifiedEnvelopeInspector } from './rooms/VerifiedEnvelopeInspector';
import { RoomHeader } from './rooms/RoomHeader';
import { RoomList } from './rooms/RoomList';
import { StatusLine } from './rooms/StatusLine';
import { ThreadPanel } from './rooms/ThreadPanel';
import { Timeline } from './rooms/Timeline';
import { useAck } from './rooms/useAck';
import { useContacts } from './rooms/useContacts';
import { useMembers } from './rooms/useMembers';
import { roomMemberName } from './rooms/resolveMentions';
import { useSend } from './rooms/useSend';

const THEME_KEY = 'sigil.theme';
const DEFAULT_THEME = 'dark';

function RoomView({ roomId, onGone, focus }: { roomId: string; onGone: () => void; focus: Pick<Mention, 'message_id' | 'room_seq'> | null }) {
  const { client, session } = useAuth();
  const sender = useSelfEndpoint();
  const membersQuery = useMembers(roomId);
  const { nameFor, loginFor, ownerNameFor } = useContacts();
  const rooms = useQuery({ queryKey: ['rooms'], queryFn: () => client.listRooms() });
  const room = rooms.data?.find((room) => room.conversation_id === roomId);
  const roomName = room?.name ?? roomId;
  const { pending, send, retry, sendError } = useSend(roomId);
  const reportSeq = useAck(roomId);
  // RoomView is keyed by room, so the open thread resets when the room changes.
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [inspectingEnvelope, setInspectingEnvelope] = useState<HistoryItem | null>(null);
  const toggleEnvelope = useCallback((item: HistoryItem) => {
    setOpenThread(null);
    setInspectingEnvelope((current) => current?.message_id === item.message_id ? null : item);
  }, []);
  // Roots of every thread opened in this room: their replies count as read even after the panel closes.
  const [seenRoots, setSeenRoots] = useState<ReadonlySet<string>>(() => new Set());
  const openThreadRoot = useCallback((rootId: string) => {
    setInspectingEnvelope(null);
    setOpenThread(rootId);
    setSeenRoots((prev) => (prev.has(rootId) ? prev : new Set(prev).add(rootId)));
  }, []);
  const self = membersQuery.data?.find((member) => member.endpoint_id === sender);
  const postingAs = sender
    ? roomMemberName({ endpoint_id: sender, display_name: self?.display_name || session?.display_name || '' }, membersQuery.data ?? [], nameFor, loginFor)
    : null;
  const disabledReason =
    sendError instanceof ApiError && (sendError.code === 'ROOM_SEND_UNAVAILABLE' || sendError.code === 'NO_SIGNING_KEY')
      ? describeError(sendError)
      : null;
  return (
    <div className="room">
      <RoomHeader roomId={roomId} name={roomName} purpose={room?.description} maxAgentTurns={room?.max_agent_turns} sender={sender} onGone={onGone} />
      <StatusLine roomId={roomId} onGone={onGone} />
      <div className="room-body">
        <div className="room-main">
          <Timeline roomId={roomId} pending={pending} onVisibleSeq={reportSeq} onGone={onGone} seenThreadRoots={seenRoots} onOpenThread={openThreadRoot} nameFor={nameFor} loginFor={loginFor} ownerNameFor={ownerNameFor} members={membersQuery.data ?? []} focus={focus} inspectingId={inspectingEnvelope?.message_id ?? null} onInspect={toggleEnvelope} />
          <div className="notices">
            {pending
              .filter((row) => row.status === 'failed' && row.retryable !== false)
              .map((row) => (
                <button key={row.idempotencyKey} className="retry" onClick={() => retry(row.idempotencyKey)}>
                  Retry{row.threadRootId ? ' (thread)' : ''}: {row.text}
                </button>
              ))}
            <ErrorBanner error={sendError && !disabledReason ? sendError : null} />
          </div>
          <Composer send={(text) => send(text)} disabledReason={disabledReason} members={membersQuery.data ?? []} nameFor={nameFor} loginFor={loginFor} viewer={sender} postingAs={postingAs} />
        </div>
        {openThread ? (
          <ThreadPanel
            key={openThread}
            roomId={roomId}
            rootId={openThread}
            pending={pending}
            onSend={(text) => send(text, openThread)}
            onClose={() => setOpenThread(null)}
            disabledReason={disabledReason}
            members={membersQuery.data ?? []}
            nameFor={nameFor}
            loginFor={loginFor}
            ownerNameFor={ownerNameFor}
            inspectingId={inspectingEnvelope?.message_id ?? null}
            onInspect={toggleEnvelope}
            postingAs={postingAs}
          />
        ) : null}
        {inspectingEnvelope ? (
          <aside className="envelope-drawer" id="envelope-drawer" aria-label="Envelope inspector">
            <VerifiedEnvelopeInspector roomId={roomId} item={inspectingEnvelope} onClose={() => setInspectingEnvelope(null)} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function Shell({ theme, onThemeChange }: { theme: string; onThemeChange: (next: string) => void }) {
  const { mode, session, isLoggedIn, loading, login, signOut, rejected } = useAuth();
  const identity = session?.display_name || (mode === 'token' ? getSender() : null);
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const [roomId, setRoomId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('room'));
  // The message to bring into view when a room opens from Mentions.
  const [focus, setFocus] = useState<Pick<Mention, 'message_id' | 'room_seq'> | null>(null);
  // On a phone the room list is a drawer; choosing a room closes it.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const selectRoom = useCallback((id: string) => {
    setRoomId(id);
    const url = new URL(window.location.href);
    url.searchParams.set('room', id);
    url.hash = '';
    window.history.replaceState(null, '', url);
    setFocus(null);
    setDrawerOpen(false);
  }, []);
  const navigate = useCallback((path: string) => {
    window.history.pushState(null, '', path);
    setPathname(path);
    setFocus(null);
    setDrawerOpen(false);
  }, []);
  const openMention = useCallback((mention: Mention) => {
    navigate('/');
    setRoomId(mention.conversation_id);
    setFocus({ message_id: mention.message_id, room_seq: mention.room_seq });
  }, [navigate]);
  useEffect(() => {
    const syncPathname = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', syncPathname);
    return () => window.removeEventListener('popstate', syncPathname);
  }, []);
  const queryClient = useQueryClient();
  const live = useLive();
  const onGone = useCallback(() => {
    setRoomId(null);
    void queryClient.invalidateQueries({ queryKey: ['rooms'] });
  }, [queryClient]);
  if (mode === 'cookie') {
    if (loading) return <p>Loading…</p>;
    if (!isLoggedIn) {
      return window.location.pathname === '/invite'
        ? <InvitePage theme={theme} onThemeChange={onThemeChange} />
        : <LoginPage theme={theme} onThemeChange={onThemeChange} />;
    }
  } else if (!isLoggedIn) return <TokenGate onSubmit={login} rejected={rejected} theme={theme} onThemeChange={onThemeChange} />;
  return (
    <main className="app" data-drawer={drawerOpen ? 'open' : 'closed'}>
      <header className="topbar">
        <button
          type="button"
          className="menu-btn"
          aria-label="Rooms"
          aria-expanded={drawerOpen}
          aria-controls="rooms-drawer"
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" fill="none" />
          </svg>
        </button>
        <strong className="brand wordmark">
          <Mark />
          <span>
            Sigil <span className="wordmark__sub">rooms</span>
          </span>
        </strong>
        <nav className="top-nav" aria-label="Main navigation">
          <button type="button" className="ghost" aria-current={pathname !== '/settings' && pathname !== '/mentions' ? 'page' : undefined} onClick={() => navigate('/')}>Rooms</button>
          <button type="button" className="ghost" aria-current={pathname === '/mentions' ? 'page' : undefined} onClick={() => navigate('/mentions')}>Mentions</button>
          <button type="button" className="ghost" aria-current={pathname === '/settings' ? 'page' : undefined} onClick={() => navigate('/settings')}>Settings</button>
        </nav>
        <span className="chip" data-live={live === 'live' ? 'true' : 'false'}>{live === 'live' ? 'Live' : 'Live: off'}</span>
        <DensityToggle />
        <ThemeToggle theme={theme} onThemeChange={onThemeChange} />
        <button className="ghost" onClick={signOut}>Sign out</button>
      </header>
      {pathname === '/settings' ? (
        <SettingsPage onBackToRooms={() => navigate('/')} />
      ) : pathname === '/mentions' ? (
        <MentionsView onOpen={openMention} />
      ) : (
        <div className="body">
          <aside className="sidebar" id="rooms-drawer">
            <div className="sidebar-list">
              <RoomList selectedId={roomId} onSelect={selectRoom} />
            </div>
            {identity ? (
              <button type="button" className="ghost identity-chip" aria-label={`Signed in as ${identity}`} onClick={() => navigate('/settings')}>
                {identity}
              </button>
            ) : null}
          </aside>
          {drawerOpen ? <button type="button" className="scrim" aria-label="Close rooms" onClick={() => setDrawerOpen(false)} /> : null}
          <section className="pane">
            {roomId ? <RoomView key={roomId} roomId={roomId} onGone={onGone} focus={focus} /> : <p className="empty">Pick a room.</p>}
          </section>
        </div>
      )}
    </main>
  );
}

export function App() {
  // Runs before any render branch so a signed-in visit to /invite#<token> still clears the secret from the URL.
  useState(() => captureInviteFragment());
  const [config, setConfig] = useState<WebConfig | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [theme, setTheme] = useState<string>(() => {
    try {
      return normalizeTheme(sessionStorage.getItem(THEME_KEY) || DEFAULT_THEME);
    } catch {
      return DEFAULT_THEME;
    }
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(THEME_KEY, theme);
    } catch { /* ignore */ }
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    loadConfig().then(setConfig, setError);
  }, []);
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
          },
          mutations: { retry: false },
        },
      }),
    [],
  );
  if (error) return <ErrorBanner error={error} />;
  if (!config) return <p>Loading…</p>;
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider
        mode={config.authMode}
        baseUrl={config.authMode === 'token' ? config.relayUrl : ''}
        streamUrl={config.authMode === 'token' ? config.streamUrl : undefined}
      >
        <Shell theme={theme} onThemeChange={setTheme} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
