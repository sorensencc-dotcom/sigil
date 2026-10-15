import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createClient, type ApiClient } from '../api/client';
import type { Session } from '../api/types';
import { clearToken, getSender, getToken, setToken } from './tokenStore';

export type AuthMode = 'token' | 'cookie';

interface AuthValue {
  mode: AuthMode;
  /** Cookie mode only: the signed-in human, or null. */
  session: Session | null;
  token: string | null;
  /** The single "is there a credential" check: a session in cookie mode, a token in token mode. */
  isLoggedIn: boolean;
  /** Cookie mode only: true until the first GET /v1/auth/me settles. */
  loading: boolean;
  login(token: string): void;
  signOut(): void;
  client: ApiClient;
  streamUrl: string;
  rejected: boolean;
}

export const AuthContext = createContext<AuthValue | null>(null);

function cookieStreamUrl(): string {
  return `${window.location.protocol === 'http:' ? 'ws' : 'wss'}://${window.location.host}`;
}

export function AuthProvider({
  mode = 'token',
  baseUrl = '',
  streamUrl,
  children,
}: {
  mode?: AuthMode;
  baseUrl?: string;
  streamUrl?: string;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const cookie = mode === 'cookie';
  const [token, setTokenState] = useState<string | null>(() => (cookie ? null : getToken()));
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(cookie);
  const [rejected, setRejected] = useState(false);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const dropSession = useCallback(() => {
    setSession(null);
    queryClient.clear();
  }, [queryClient]);

  const clientRef = useRef<ApiClient | null>(null);
  const signOut = useCallback(() => {
    if (cookie) {
      // Best effort: the server revokes the session, and the UI leaves the signed-in state either way.
      void clientRef.current?.logout().catch(() => {});
      dropSession();
      return;
    }
    clearToken();
    setTokenState(null);
    queryClient.clear();
  }, [cookie, dropSession, queryClient]);

  const client = useMemo(
    () =>
      createClient({
        mode,
        baseUrl,
        getToken: () => tokenRef.current,
        onUnauthorized: () => {
          if (cookie) {
            dropSession();
            return;
          }
          setRejected(true);
          signOut();
        },
      }),
    [mode, baseUrl, cookie, dropSession, signOut],
  );
  clientRef.current = client;

  useEffect(() => {
    if (!cookie) return;
    let cancelled = false;
    client.me().then(
      (me) => {
        if (cancelled) return;
        setSession(me);
        setLoading(false);
      },
      () => {
        if (cancelled) return;
        setSession(null);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cookie, client]);

  const login = useCallback(
    (next: string) => {
      if (cookie) return;
      setToken(next);
      setRejected(false);
      setTokenState(getToken());
      queryClient.clear();
    },
    [cookie, queryClient],
  );

  const resolvedStreamUrl = cookie ? cookieStreamUrl() : (streamUrl ?? '');
  const isLoggedIn = cookie ? session !== null : !!token;
  const value = useMemo(
    () => ({ mode, session, token, isLoggedIn, loading, login, signOut, client, streamUrl: resolvedStreamUrl, rejected }),
    [mode, session, token, isLoggedIn, loading, login, signOut, client, resolvedStreamUrl, rejected],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth outside AuthProvider');
  return value;
}

/** This browser's own endpoint ID: the session's in cookie mode (never reads the sender store), the learned sender in token mode. */
export function useSelfEndpoint(): string | null {
  const { mode, session } = useAuth();
  return mode === 'cookie' ? (session?.endpoint_id ?? null) : getSender();
}

export function TestAuthProvider({
  client,
  children,
  streamUrl = 'ws://stream.test',
  mode = 'token',
  session = null,
}: {
  client: ApiClient;
  children: ReactNode;
  streamUrl?: string;
  mode?: AuthMode;
  session?: Session | null;
}) {
  const value: AuthValue = { mode, session, token: mode === 'token' ? 'tok' : null, isLoggedIn: mode === 'token' || session !== null, loading: false, login() {}, signOut() {}, client, streamUrl, rejected: false };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
