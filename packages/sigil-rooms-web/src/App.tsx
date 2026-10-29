import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from './api/client';
import { AuthProvider, useAuth, useSelfEndpoint } from './auth/AuthContext';
import { Mark, normalizeTheme, ThemeToggle } from './auth/GateHeader';
import { TokenGate } from './auth/TokenGate';
import { loadConfig, type WebConfig } from './config';
import { describeError, ErrorBanner } from './errors/ErrorBanner';
import { useLive } from './live/useLive';
import { captureInviteFragment, InvitePage } from './pages/InvitePage';
import { LoginPage } from './pages/LoginPage';
import { Composer } from './rooms/Composer';
import { RoomHeader } from './rooms/RoomHeader';
import { RoomList } from './rooms/RoomList';
import { ThreadPanel } from './rooms/ThreadPanel';
import { Timeline } from './rooms/Timeline';
import { useAck } from './rooms/useAck';
import { useContacts } from './rooms/useContacts';
import { useMembers } from './rooms/useMembers';
import { useSend } from './rooms/useSend';

const THEME_KEY = 'sigil.theme';
const DEFAULT_THEME = 'dark';

function RoomView({ roomId, onGone }: { roomId: string; onGone: () => void }) {
  const { client } = useAuth();
  const sender = useSelfEndpoint();
  const membersQuery = useMembers(roomId);
  const { nameFor, loginFor } = useContacts();
  const rooms = useQuery({ queryKey: ['rooms'], queryFn: () => client.listRooms() });
  const roomName = rooms.data?.find((room) => room.conversation_id === roomId)?.name ?? roomId;
  const { pending, send, retry, sendError } = useSend(roomId);
  const reportSeq = useAck(roomId);
  // RoomView is keyed by room, so the open thread resets when the room changes.
  const [openThread, setOpenThread] = useState<string | null>(null);
  // Roots of every thread opened in this room: their replies count as read even after the panel closes.
  const [seenRoots, setSeenRoots] = useState<ReadonlySet<string>>(() => new Set());
  const openThreadRoot = useCallback((rootId: string) => {
    setOpenThread(rootId);
    setSeenRoots((prev) => (prev.has(rootId) ? prev : new Set(prev).add(rootId)));
  }, []);
  const disabledReason =
    sendError instanceof ApiError && (sendError.code === 'ROOM_SEND_UNAVAILABLE' || sendError.code === 'NO_SIGNING_KEY')
      ? describeError(sendError)
      : null;
  return (
    <div className="room">
      <RoomHeader roomId={roomId} name={roomName} sender={sender} onGone={onGone} />
      <div className="room-body">
        <div className="room-main">
          <Timeline roomId={roomId} pending={pending} onVisibleSeq={reportSeq} onGone={onGone} seenThreadRoots={seenRoots} onOpenThread={openThreadRoot} nameFor={nameFor} loginFor={loginFor} members={membersQuery.data ?? []} />
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
          <Composer send={(text) => send(text)} disabledReason={disabledReason} members={membersQuery.data ?? []} nameFor={nameFor} loginFor={loginFor} />
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
          />
        ) : null}
      </div>
    </div>
  );
}

function Shell({ theme, onThemeChange }: { theme: string; onThemeChange: (next: string) => void }) {
  const { mode, isLoggedIn, loading, login, signOut, rejected } = useAuth();
  const [roomId, setRoomId] = useState<string | null>(null);
  // On a phone the room list is a drawer; choosing a room closes it.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const selectRoom = useCallback((id: string) => {
    setRoomId(id);
    setDrawerOpen(false);
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
        <span className="chip" data-live={live === 'live' ? 'true' : 'false'}>{live === 'live' ? 'Live' : 'Live: off'}</span>
        <ThemeToggle theme={theme} onThemeChange={onThemeChange} />
        <button className="ghost" onClick={signOut}>Sign out</button>
      </header>
      <div className="body">
        <aside className="sidebar" id="rooms-drawer">
          <RoomList selectedId={roomId} onSelect={selectRoom} />
        </aside>
        {drawerOpen ? <button type="button" className="scrim" aria-label="Close rooms" onClick={() => setDrawerOpen(false)} /> : null}
        <section className="pane">
          {roomId ? <RoomView key={roomId} roomId={roomId} onGone={onGone} /> : <p className="empty">Pick a room.</p>}
        </section>
      </div>
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
