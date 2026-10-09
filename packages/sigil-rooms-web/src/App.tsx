import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from './api/client';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { TokenGate } from './auth/TokenGate';
import { loadConfig, type WebConfig } from './config';
import { describeError, ErrorBanner } from './errors/ErrorBanner';
import { useLive } from './live/useLive';
import { Composer } from './rooms/Composer';
import { RoomList } from './rooms/RoomList';
import { ThreadPanel } from './rooms/ThreadPanel';
import { Timeline } from './rooms/Timeline';
import { useAck } from './rooms/useAck';
import { useSend } from './rooms/useSend';

const THEME_KEY = 'sigil.theme';
const DEFAULT_THEME = 'rewrite-labs';

function RoomView({ roomId, onGone }: { roomId: string; onGone: () => void }) {
  const { pending, send, retry, sendError } = useSend(roomId);
  const reportSeq = useAck(roomId);
  // RoomView is keyed by room, so the open thread resets when the room changes.
  const [openThread, setOpenThread] = useState<string | null>(null);
  const disabledReason =
    sendError instanceof ApiError && (sendError.code === 'ROOM_SEND_UNAVAILABLE' || sendError.code === 'NO_SIGNING_KEY')
      ? describeError(sendError)
      : null;
  return (
    <div className="room">
      <div className="room-body">
        <div className="room-main">
          <Timeline roomId={roomId} pending={pending} onVisibleSeq={reportSeq} onGone={onGone} openThreadRoot={openThread} onOpenThread={setOpenThread} />
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
          <Composer send={(text) => send(text)} disabledReason={disabledReason} />
        </div>
        {openThread ? (
          <ThreadPanel
            roomId={roomId}
            rootId={openThread}
            pending={pending}
            onSend={(text) => send(text, openThread)}
            onClose={() => setOpenThread(null)}
            disabledReason={disabledReason}
          />
        ) : null}
      </div>
    </div>
  );
}

function Shell({ theme, onThemeChange }: { theme: string; onThemeChange: (next: string) => void }) {
  const { token, login, signOut, rejected } = useAuth();
  const [roomId, setRoomId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const live = useLive();
  const onGone = useCallback(() => {
    setRoomId(null);
    void queryClient.invalidateQueries({ queryKey: ['rooms'] });
  }, [queryClient]);
  if (!token) return <TokenGate onSubmit={login} rejected={rejected} theme={theme} onThemeChange={onThemeChange} />;
  return (
    <main className="app">
      <header className="topbar">
        <strong className="brand">Sigil rooms</strong>
        <span className="chip" data-live={live === 'live' ? 'true' : 'false'}>{live === 'live' ? 'Live' : 'Live: off'}</span>
        <select
          aria-label="Theme"
          className="theme-select"
          value={theme}
          onChange={(e) => onThemeChange(e.target.value)}
        >
          <option value="rewrite-labs">Rewrite Labs</option>
          <option value="cast-iron-charlie">Cast Iron Charlie (Dark)</option>
          <option value="cast-iron-charlie-light">Cast Iron Charlie (Paper)</option>
        </select>
        <button className="ghost" onClick={signOut}>Sign out</button>
      </header>
      <div className="body">
        <aside className="sidebar">
          <RoomList selectedId={roomId} onSelect={setRoomId} />
        </aside>
        <section className="pane">
          {roomId ? <RoomView key={roomId} roomId={roomId} onGone={onGone} /> : <p className="empty">Pick a room.</p>}
        </section>
      </div>
    </main>
  );
}

export function App() {
  const [config, setConfig] = useState<WebConfig | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [theme, setTheme] = useState<string>(() => {
    try {
      return sessionStorage.getItem(THEME_KEY) || DEFAULT_THEME;
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
      <AuthProvider baseUrl={config.relayUrl} streamUrl={config.streamUrl}>
        <Shell theme={theme} onThemeChange={setTheme} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
