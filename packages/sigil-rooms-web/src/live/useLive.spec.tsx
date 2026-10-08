import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import { TestAuthProvider } from '../auth/AuthContext';

const sockets = vi.hoisted(
  () => [] as Array<{ onFrame: (f: unknown) => void; onStatus: (s: 'live' | 'off') => void; onReconnect: () => void }>,
);
vi.mock('./socket', () => ({
  LiveSocket: class {
    constructor(options: (typeof sockets)[number]) { sockets.push(options); }
    start() {}
    stop() {}
  },
}));

const fakeClient = { wsTicket: async () => ({ code: 'OK', ticket: 't', expires_at: 'e' }) } as unknown as ApiClient;

import { useLive } from './useLive';

describe('useLive', () => {
  beforeEach(() => { sockets.length = 0; });

  function setup() {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const cancel = vi.spyOn(queryClient, 'cancelQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TestAuthProvider client={fakeClient}>{children}</TestAuthProvider>
      </QueryClientProvider>
    );
    return { spy, cancel, ...renderHook(() => useLive(), { wrapper }) };
  }

  it('invalidates the room history on a messages frame', async () => {
    const { spy } = setup();
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.onFrame({ type: 'room.updated', room_id: 'room_1', room_seq: '3', changed: 'messages' });
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['room', 'room_1', 'messages'] }));
  });

  it('cancels in-flight history fetches before invalidating on a messages frame', async () => {
    const { spy, cancel } = setup();
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.onFrame({ type: 'room.updated', room_id: 'room_1', room_seq: '3', changed: 'messages' });
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['room', 'room_1', 'messages'] }));
    expect(cancel).toHaveBeenCalledWith({ queryKey: ['room', 'room_1', 'messages'] });
    expect(cancel.mock.invocationCallOrder[0]!).toBeLessThan(spy.mock.invocationCallOrder[0]!);
  });

  it('still invalidates when cancelQueries rejects', async () => {
    const { spy, cancel } = setup();
    cancel.mockRejectedValueOnce(new Error('boom'));
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.onFrame({ type: 'room.updated', room_id: 'room_1', room_seq: '3', changed: 'messages' });
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['room', 'room_1', 'messages'] }));
  });

  it('invalidates the room list on a members frame', async () => {
    const { spy } = setup();
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.onFrame({ type: 'room.updated', room_id: 'room_1', changed: 'members' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['rooms'] });
  });

  it('invalidates everything after a reconnect and reports status', async () => {
    const { spy, result } = setup();
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.onStatus('live');
    await waitFor(() => expect(result.current).toBe('live'));
    sockets[0]!.onReconnect();
    expect(spy).toHaveBeenCalledWith();
  });
});
