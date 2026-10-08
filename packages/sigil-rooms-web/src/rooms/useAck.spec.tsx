import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import { TestAuthProvider } from '../auth/AuthContext';
import { useAck } from './useAck';

function setup(ack: ApiClient['ack']) {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestAuthProvider client={{ ack } as ApiClient}>{children}</TestAuthProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useAck('room_1', 50), { wrapper });
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useAck', () => {
  beforeEach(() => { vi.useFakeTimers(); setVisibility('visible'); });
  afterEach(() => { vi.useRealTimers(); });

  it('debounces and acks only the highest seq', async () => {
    const ack = vi.fn(async () => ({ code: 'OK', acknowledged: 1 }));
    const { result } = setup(ack);
    act(() => { result.current('2'); result.current('5'); result.current('9'); });
    expect(ack).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith('room_1', '9');
  });

  it('is forward-only: a lower or equal seq does not ack again', async () => {
    const ack = vi.fn(async () => ({ code: 'OK', acknowledged: 1 }));
    const { result } = setup(ack);
    act(() => result.current('9'));
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    act(() => { result.current('9'); result.current('4'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('holds the ack while the tab is hidden and sends it on the next visibility change', async () => {
    const ack = vi.fn(async () => ({ code: 'OK', acknowledged: 1 }));
    const { result } = setup(ack);
    setVisibility('hidden');
    act(() => result.current('7'));
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(ack).not.toHaveBeenCalled();
    setVisibility('visible');
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(ack).toHaveBeenCalledWith('room_1', '7');
  });

  it('swallows an ack failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ack = vi.fn(async () => { throw new Error('boom'); });
    const { result } = setup(ack);
    act(() => result.current('3'));
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(warn).toHaveBeenCalled();
  });
});
