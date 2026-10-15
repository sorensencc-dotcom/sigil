import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import type { Member } from '../api/types';
import { TestAuthProvider } from '../auth/AuthContext';
import * as tokenStore from '../auth/tokenStore';
import { RoomHeader } from './RoomHeader';
import { RoomList } from './RoomList';
import { useSend } from './useSend';

const members: Member[] = [
  { endpoint_id: 'ep_me', role: 'owner', response_mode: null, added_at: 't', invokable_by: 'owner', owner_id: null, display_name: 'Me' },
];
const session = (is_operator: boolean) => ({ human_id: 'h1', endpoint_id: 'ep_me', display_name: 'Me', is_operator });

function wrap(client: Partial<ApiClient>, is_operator: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestAuthProvider client={client as ApiClient} mode="cookie" session={session(is_operator)}>{children}</TestAuthProvider>
    </QueryClientProvider>
  );
}

describe('cookie-mode consumers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('hides Create room from a non-operator and shows it to the operator', async () => {
    const client = { listRooms: vi.fn(async () => []) };
    const first = render(<RoomList selectedId={null} onSelect={() => {}} />, { wrapper: wrap(client, false) });
    await screen.findByText('No rooms yet.');
    expect(screen.queryByLabelText('New room name')).toBeNull();
    first.unmount();
    render(<RoomList selectedId={null} onSelect={() => {}} />, { wrapper: wrap(client, true) });
    expect(await screen.findByLabelText('New room name')).toBeInTheDocument();
  });

  it('labels the stop control by role and posts the same stop', async () => {
    const stopRoom = vi.fn(async () => ({ code: 'OK', cancelled: 0 }));
    const client = { listMembers: vi.fn(async () => members), stopRoom };
    const a = render(<RoomHeader roomId="room_1" name="b" sender={null} onGone={() => {}} />, { wrapper: wrap(client, false) });
    expect(screen.queryByRole('button', { name: 'Stop room' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Stop my runs' }));
    expect(stopRoom).toHaveBeenCalledWith('room_1');
    a.unmount();
    render(<RoomHeader roomId="room_1" name="b" sender={null} onGone={() => {}} />, { wrapper: wrap(client, true) });
    expect(screen.getByRole('button', { name: 'Stop room' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop my runs' })).toBeNull();
  });

  it('useSend never reads or writes the stored sender in cookie mode', async () => {
    const getSender = vi.spyOn(tokenStore, 'getSender');
    const setSender = vi.spyOn(tokenStore, 'setSender');
    const client = {
      sendMessage: vi.fn(async () => ({ message_id: 'm1' })),
      history: vi.fn(async () => ({ items: [{ message_id: 'm1', room_seq: '1', envelope: { sender: { endpoint_id: 'ep_other' } } }], next_after_seq: '1', has_more: false }) as never),
    };
    const { result } = renderHook(() => useSend('room_1'), { wrapper: wrap(client as never, false) });
    await act(async () => result.current.send('hi'));
    await waitFor(() => expect(client.history).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(getSender).not.toHaveBeenCalled();
    expect(setSender).not.toHaveBeenCalled();
  });
});
