import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { Member } from '../api/types';
import { renderWithClient } from '../testUtils';
import { StatusLine } from './StatusLine';

const members: Member[] = [
  { endpoint_id: 'ep_web', role: 'owner', response_mode: null, added_at: 't', invokable_by: 'owner', owner_id: null, display_name: 'Web' },
  { endpoint_id: 'ep_agent', role: 'member', response_mode: 'joins', added_at: 't', invokable_by: 'owner', owner_id: null, display_name: 'Claude' },
];

describe('StatusLine', () => {
  it('names the working agent and shows Stop only while there is active work', async () => {
    const client = {
      listMembers: vi.fn(async () => members),
      listInvocations: vi.fn(async () => [{ invocation_id: 'i1', endpoint_id: 'ep_agent', status: 'running' as const }]),
      stopRoom: vi.fn(async () => ({ code: 'OK', cancelled: 1 })),
    };
    const view = renderWithClient(<StatusLine roomId="room_1" onGone={() => {}} />, client);
    expect(await screen.findByRole('status')).toHaveTextContent('Working: Claude');
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(client.stopRoom).toHaveBeenCalledWith('room_1');
    await vi.waitFor(() => expect(client.listInvocations).toHaveBeenCalledTimes(2));
  });

  it('stays hidden while the room is idle', async () => {
    renderWithClient(<StatusLine roomId="room_1" onGone={() => {}} />, {
      listMembers: vi.fn(async () => members),
      listInvocations: vi.fn(async () => []),
    });
    await vi.waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('shows an invocation fetch failure', async () => {
    renderWithClient(<StatusLine roomId="room_1" onGone={() => {}} />, {
      listMembers: vi.fn(async () => members),
      listInvocations: vi.fn(async () => { throw new ApiError('NETWORK', 0, 'offline'); }),
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('returns to the room list when Stop reports that the room is gone', async () => {
    const onGone = vi.fn();
    const client = {
      listMembers: vi.fn(async () => members),
      listInvocations: vi.fn(async () => [{ invocation_id: 'i1', endpoint_id: 'ep_agent', status: 'queued' as const }]),
      stopRoom: vi.fn(async () => { throw new ApiError('ROOM_NOT_FOUND', 404, 'gone'); }),
    };
    renderWithClient(<StatusLine roomId="room_1" onGone={onGone} />, client);
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await vi.waitFor(() => expect(onGone).toHaveBeenCalled());
  });
});
