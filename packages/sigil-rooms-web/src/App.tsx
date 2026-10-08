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
import { Timeline } from './rooms/Timeline';
import { useAck } from './rooms/useAck';
import { useSend } from './rooms/useSend';

function RoomView({ roomId, onGone }: { roomId: string; onGone: () => void }) {
  const { pending, send, retry, sendError } = useSend(roomId);
  const reportSeq = useAck(roomId);
  const disabledReason =
    sendError instanceof ApiError && (sendError.code === 'ROOM_SEND_UNAVAILABLE' || sendError.code === 'NO_SIGNING_KEY')
      ? describeError(sendError)
      : null;
  return (
    <>
      <Timeline roomId={roomId} pending={pending} onVisibleSeq={reportSeq} onGone={onGone} />
      {pending
        .filter((row) => row.status === 'failed' && row.retryable !== false)
        .map((row) => (
          <button key={row.idempotencyKey} onClick={() => retry(row.idempotencyKey)}>
            Retry: {row.text}
          </button>
        ))}
      <ErrorBanner error={sendError && !disabledReason ? sendError : null} />
      <Composer send={send} disabledReason={disabledReason} />
    </>
  );
}

function Shell() {
  const { token, login, signOut, rejected } = useAuth();
  const [roomId, setRoomId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const live = useLive();
  const onGone = useCallback(() => {
    setRoomId(null);
    void queryClient.invalidateQueries({ queryKey: ['rooms'] });
  }, [queryClient]);
  if (!token) return <TokenGate onSubmit={login} rejected={rejected} />;
  return (
    <main>
      <header>
        <strong>Sigil rooms</strong> <button onClick={signOut}>Sign out</button> <span>{live === 'live' ? 'Live' : 'Live: off'}</span>
      </header>
      <RoomList selectedId={roomId} onSelect={setRoomId} />
      {roomId ? <RoomView key={roomId} roomId={roomId} onGone={onGone} /> : <p>Pick a room.</p>}
    </main>
  );
}

export function App() {
  const [config, setConfig] = useState<WebConfig | null>(null);
  const [error, setError] = useState<unknown>(null);
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
        <Shell />
      </AuthProvider>
    </QueryClientProvider>
  );
}
