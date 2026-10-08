import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { createClient, type ApiClient } from '../api/client';
import { clearToken, getToken, setToken } from './tokenStore';

interface AuthValue {
  token: string | null;
  login(token: string): void;
  signOut(): void;
  client: ApiClient;
  streamUrl: string;
  rejected: boolean;
}

export const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ baseUrl, streamUrl, children }: { baseUrl: string; streamUrl: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [rejected, setRejected] = useState(false);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const signOut = useCallback(() => {
    clearToken();
    setTokenState(null);
    queryClient.clear();
  }, [queryClient]);

  const client = useMemo(
    () =>
      createClient({
        baseUrl,
        getToken: () => tokenRef.current,
        onUnauthorized: () => {
          setRejected(true);
          signOut();
        },
      }),
    [baseUrl, signOut],
  );

  const login = useCallback(
    (next: string) => {
      setToken(next);
      setRejected(false);
      setTokenState(getToken());
      queryClient.clear();
    },
    [queryClient],
  );

  const value = useMemo(
    () => ({ token, login, signOut, client, streamUrl, rejected }),
    [token, login, signOut, client, streamUrl, rejected],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth outside AuthProvider');
  return value;
}

export function TestAuthProvider({ client, children, streamUrl = 'ws://stream.test' }: { client: ApiClient; children: ReactNode; streamUrl?: string }) {
  const value: AuthValue = { token: 'tok', login() {}, signOut() {}, client, streamUrl, rejected: false };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
