import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient } from '../api/client';
import type { Member } from '../api/types';
import { TestAuthProvider } from '../auth/AuthContext';
import { membersKey } from './useMembers';
import { useSend } from './useSend';

const members: Member[] = [
  { endpoint_id: 'ep_web', role: 'owner', response_mode: null, added_at: 't', invokable_by: 'owner', owner_id: 'usr_a', display_name: 'Ada' },
  { endpoint_id: 'ep_chief', role: 'member', response_mode: 'mentions_only', added_at: 't', invokable_by: 'members', owner_id: 'usr_b', display_name: 'Chief' },
];

function setup(client: Partial<ApiClient>, seedMembers = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seedMembers) queryClient.setQueryData(membersKey('room_1'), members);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestAuthProvider client={client as ApiClient}>{children}</TestAuthProvider>
    </QueryClientProvider>
  );
  return { ...renderHook(() => useSend('room_1'), { wrapper }), queryClient };
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
    expect(sendMessage.mock.calls[1]).toEqual(['room_1', 'hi', key, 'msg_root', undefined]);
  });

  it('sends a top-level message with no thread id', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ code: 'OK', message_id: 'm1', room_seq: '1' });
    const { result } = setup({ sendMessage, history });
    act(() => result.current.send('top'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]![3]).toBeUndefined();
    expect(sendMessage.mock.calls[0]![4]).toBeUndefined();
    expect(result.current.pending[0]?.threadRootId).toBeUndefined();
  });
});

describe('useSend mentions', () => {
  it('resolves @tokens against cached members and passes mentions to sendMessage', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ code: 'OK', message_id: 'm1', room_seq: '1' });
    const { result } = setup({ sendMessage, history });
    act(() => result.current.send('@ep_chief ping'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]).toEqual(['room_1', '@ep_chief ping', expect.any(String), undefined, ['ep_chief']]);
  });

  it('resolves display-name mentions and re-resolves on retry', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('HTTP_500', 500, 'boom'))
      .mockResolvedValueOnce({ code: 'OK', message_id: 'm2', room_seq: '2' });
    const { result } = setup({ sendMessage, history });
    act(() => result.current.send('hey @Chief'));
    await waitFor(() => expect(result.current.pending[0]?.status).toBe('failed'));
    const key = result.current.pending[0]!.idempotencyKey;
    act(() => result.current.retry(key));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls[0]![4]).toEqual(['ep_chief']);
    expect(sendMessage.mock.calls[1]![4]).toEqual(['ep_chief']);
  });

  it('sends viewer contact mentions as endpoint IDs in both text and mentions', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ code: 'OK', message_id: 'm3', room_seq: '3' });
    const listContacts = vi.fn(async () => [
      { contact_id: 'ct_1', kind: 'human' as const, login: 'usr_chief', display_name: 'Chief Contact', created_at: '', updated_at: '', endpoint_ids: ['ep_chief'] },
    ]);
    const { result } = setup({ sendMessage, listContacts, history });
    act(() => result.current.send('hello @Chief Contact'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]).toEqual(['room_1', 'hello @ep_chief', expect.any(String), undefined, ['ep_chief']]);
  });

  it('fetches members when the cache is empty', async () => {
    const listMembers = vi.fn(async () => members);
    const sendMessage = vi.fn().mockResolvedValue({ code: 'OK', message_id: 'm1', room_seq: '1' });
    const { result } = setup({ sendMessage, history, listMembers }, false);
    act(() => result.current.send('@ep_chief hi'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(listMembers).toHaveBeenCalledWith('room_1');
    expect(sendMessage.mock.calls[0]![4]).toEqual(['ep_chief']);
  });

  it('still sends when member lookup fails', async () => {
    const listMembers = vi.fn(async () => { throw new ApiError('HTTP_500', 500, 'roster down'); });
    const sendMessage = vi.fn().mockResolvedValue({ code: 'OK', message_id: 'm1', room_seq: '1' });
    const { result } = setup({ sendMessage, history, listMembers }, false);
    act(() => result.current.send('@ep_chief hi'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]![4]).toBeUndefined();
  });
});
