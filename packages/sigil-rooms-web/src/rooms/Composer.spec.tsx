import { act, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient } from '../api/client';
import { TestAuthProvider } from '../auth/AuthContext';
import { getSender } from '../auth/tokenStore';
import { renderWithClient } from '../testUtils';
import { Composer } from './Composer';
import { useSend } from './useSend';

function wrapper(client: Partial<ApiClient>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestAuthProvider client={client as ApiClient}>{children}</TestAuthProvider>
    </QueryClientProvider>
  );
}

const emptyHistory = async () => ({ code: 'OK', items: [], next_after_seq: '0' });

describe('Composer', () => {
  it('sends the typed text and clears the box', async () => {
    const send = vi.fn();
    renderWithClient(<Composer send={send} disabledReason={null} />, {});
    await userEvent.type(screen.getByRole('textbox'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(send).toHaveBeenCalledWith('hello');
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('ignores blank text', async () => {
    const send = vi.fn();
    renderWithClient(<Composer send={send} disabledReason={null} />, {});
    await userEvent.type(screen.getByRole('textbox'), '   ');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(send).not.toHaveBeenCalled();
  });

  it('is disabled with a reason', () => {
    renderWithClient(<Composer send={() => {}} disabledReason="Sending is not configured." />, {});
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByText('Sending is not configured.')).toBeInTheDocument();
  });
});

describe('useSend', () => {
  beforeEach(() => sessionStorage.clear());

  it('adds a sending row, then records message_id and the sender on success', async () => {
    const sendMessage = vi.fn(async () => ({ code: 'OK', message_id: 'm9', room_seq: '9' }));
    const history = vi.fn(async () => ({
      code: 'OK', next_after_seq: '9',
      items: [{ room_seq: '9', message_id: 'm9', canonical_bytes: 'b', envelope: { message_id: 'm9', message_type: 'room.message', sender: { endpoint_id: 'ep_web', owner_id: 'u' }, body: { text: 'hi' }, created_at: 't' } }],
    }));
    const { result } = renderHook(() => useSend('room_1'), { wrapper: wrapper({ sendMessage, history }) });
    act(() => result.current.send('hi'));
    expect(result.current.pending[0]).toMatchObject({ text: 'hi', status: 'sending' });
    await waitFor(() => expect(result.current.pending[0]?.messageId).toBe('m9'));
    await waitFor(() => expect(getSender()).toBe('ep_web'));
  });

  it('marks the row failed and retries with the same idempotency key', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new ApiError('NETWORK', 0, 'offline'))
      .mockResolvedValueOnce({ code: 'OK', message_id: 'm1', room_seq: '1' });
    const history = vi.fn(emptyHistory);
    const { result } = renderHook(() => useSend('room_1'), { wrapper: wrapper({ sendMessage, history }) });
    act(() => result.current.send('hi'));
    await waitFor(() => expect(result.current.pending[0]?.status).toBe('failed'));
    expect(result.current.pending[0]?.retryable).toBe(true);
    const key = result.current.pending[0]!.idempotencyKey;
    act(() => result.current.retry(key));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls[0]![2]).toBe(sendMessage.mock.calls[1]![2]);
    expect(sendMessage.mock.calls[1]![2]).toBe(key);
  });

  it('treats a 200 replay like a 201', async () => {
    const sendMessage = vi.fn(async () => ({ code: 'OK', message_id: 'm2', room_seq: '2' }));
    const history = vi.fn(emptyHistory);
    const { result } = renderHook(() => useSend('room_1'), { wrapper: wrapper({ sendMessage, history }) });
    act(() => result.current.send('again'));
    await waitFor(() => expect(result.current.pending[0]?.messageId).toBe('m2'));
  });

  it('keeps the relay message on a 400 and marks it not retryable', async () => {
    const sendMessage = vi.fn(async () => { throw new ApiError('INVALID_ENVELOPE', 400, 'text too long'); });
    const { result } = renderHook(() => useSend('room_1'), { wrapper: wrapper({ sendMessage }) });
    act(() => result.current.send('x'));
    await waitFor(() => expect(result.current.pending[0]).toMatchObject({ status: 'failed', error: 'text too long', retryable: false }));
  });

  it('marks a 403 NO_SIGNING_KEY not retryable but a 403 with another code retryable', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new ApiError('NO_SIGNING_KEY', 403, 'no key'))
      .mockRejectedValueOnce(new ApiError('FORBIDDEN', 403, 'nope'));
    const { result } = renderHook(() => useSend('room_1'), { wrapper: wrapper({ sendMessage }) });
    act(() => result.current.send('a'));
    act(() => result.current.send('b'));
    await waitFor(() => expect(result.current.pending.every((row) => row.status === 'failed')).toBe(true));
    expect(result.current.pending.find((row) => row.text === 'a')?.retryable).toBe(false);
    expect(result.current.pending.find((row) => row.text === 'b')?.retryable).toBe(true);
  });

  it('does not mark an accepted message failed when the history refetch fails', async () => {
    const sendMessage = vi.fn(async () => ({ code: 'OK', message_id: 'm3', room_seq: '3' }));
    const history = vi.fn(async () => { throw new ApiError('NETWORK', 0, 'offline'); });
    const { result } = renderHook(() => useSend('room_1'), { wrapper: wrapper({ sendMessage, history }) });
    act(() => result.current.send('ok'));
    await waitFor(() => expect(history).toHaveBeenCalled());
    await waitFor(() => expect(result.current.pending[0]?.messageId).toBe('m3'));
    expect(result.current.pending[0]?.status).toBe('sending');
    expect(result.current.sendError).toBeNull();
  });

  it('keeps pending rows per room', async () => {
    const sendMessage = vi.fn(async () => ({ code: 'OK', message_id: 'm4', room_seq: '4' }));
    const history = vi.fn(emptyHistory);
    const { result, rerender } = renderHook(({ room }) => useSend(room), { wrapper: wrapper({ sendMessage, history }), initialProps: { room: 'room_1' } });
    act(() => result.current.send('in one'));
    rerender({ room: 'room_2' });
    expect(result.current.pending).toEqual([]);
    rerender({ room: 'room_1' });
    expect(result.current.pending).toHaveLength(1);
  });
});
