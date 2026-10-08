import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from './api/client';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { TokenGate } from './auth/TokenGate';
import { loadConfig, type WebConfig } from './config';
import { ErrorBanner } from './errors/ErrorBanner';

function Shell() {
  const { token, login, signOut, rejected } = useAuth();
  if (!token) return <TokenGate onSubmit={login} rejected={rejected} />;
  return (
    <main>
      <header>
        <strong>Sigil rooms</strong> <button onClick={signOut}>Sign out</button>
      </header>
      <p>Connected.</p>
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
