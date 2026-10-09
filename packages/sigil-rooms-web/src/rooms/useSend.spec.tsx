import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient } from '../api/client';
import { TestAuthProvider } from '../auth/AuthContext';
import { useSend } from './useSend';

function setup(client: Partial<ApiClient>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestAuthProvider client={client as ApiClient}>{children}</TestAuthProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useSend('room_1'), { wrapper });
}

const history = async () => ({ code: 'OK', items: [], next_after_seq: '0' });

describe('useSend threads', () => {
  it('keeps the thread id on a failed reply and reuses it, the text, and the key on retry', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('HTTP_500', 500, 'boom'))
      .mockResolvedValueOnce({ code: 'OK', message_id: 'm2', room_seq: '5' });
    const { result } = setup({ sendMessage, history });
    act(() => result.current.send('hi', 'msg_root'));
    await waitFor(() => expect(result.current.pending[0]?.status).toBe('failed'));
    expect(result.current.pending[0]?.threadRootId).toBe('msg_root');
    const key = result.current.pending[0]!.idempotencyKey;
    act(() => result.current.retry(key));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls[1]).toEqual(['room_1', 'hi', key, 'msg_root']);
  });

  it('sends a top-level message with no thread id', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ code: 'OK', message_id: 'm1', room_seq: '1' });
    const { result } = setup({ sendMessage, history });
    act(() => result.current.send('top'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]![3]).toBeUndefined();
    expect(result.current.pending[0]?.threadRootId).toBeUndefined();
  });
});
