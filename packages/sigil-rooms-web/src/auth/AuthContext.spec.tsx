import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
import { setToken } from './tokenStore';

function setup() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(['rooms'], [{ id: 'stale' }]);
  let auth!: ReturnType<typeof useAuth>;
  function Probe() {
    auth = useAuth();
    return null;
  }
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider baseUrl="http://relay" streamUrl="ws://relay">
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { queryClient, get auth() { return auth; } };
}

describe('AuthProvider cache clearing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('clears the query cache on signOut', () => {
    setToken('t1');
    const ctx = setup();
    expect(ctx.queryClient.getQueryData(['rooms'])).toBeDefined();
    act(() => ctx.auth.signOut());
    expect(ctx.queryClient.getQueryData(['rooms'])).toBeUndefined();
    expect(ctx.auth.token).toBeNull();
  });

  it('clears the query cache when a request gets a 401', async () => {
    setToken('t1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'UNAUTHORIZED' }), { status: 401 })));
    const ctx = setup();
    await act(async () => {
      await ctx.auth.client.listRooms().catch(() => {});
    });
    expect(ctx.queryClient.getQueryData(['rooms'])).toBeUndefined();
    expect(ctx.auth.token).toBeNull();
    expect(ctx.auth.rejected).toBe(true);
  });

  it('clears the query cache on login with a new token', () => {
    const ctx = setup();
    expect(ctx.queryClient.getQueryData(['rooms'])).toBeDefined();
    act(() => ctx.auth.login('t2'));
    expect(ctx.queryClient.getQueryData(['rooms'])).toBeUndefined();
    expect(ctx.auth.token).toBe('t2');
  });
});
