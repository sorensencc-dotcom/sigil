import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { HistoryItem, Member } from '../api/types';
import { renderWithClient } from '../testUtils';
import { RoomList } from './RoomList';

const rooms = [
  { conversation_id: 'room_1', workspace_id: 'ws', name: 'build', description: 'the build room', created_at: 't', max_agent_turns: 6 },
  { conversation_id: 'room_2', workspace_id: 'ws', name: 'ops', description: null, created_at: 't', max_agent_turns: 6 },
];

describe('RoomList', () => {
  it('lists rooms and reports a selection', async () => {
    const onSelect = vi.fn();
    renderWithClient(<RoomList selectedId={null} onSelect={onSelect} />, { listRooms: async () => rooms });
    await userEvent.click(await screen.findByRole('button', { name: /^build/ }));
    expect(onSelect).toHaveBeenCalledWith('room_1');
    expect(screen.getByText('the build room')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    renderWithClient(<RoomList selectedId={null} onSelect={() => {}} />, { listRooms: async () => [] });
    expect(await screen.findByText(/no rooms/i)).toBeInTheDocument();
  });

  it('shows the error banner when the list fails', async () => {
    renderWithClient(<RoomList selectedId={null} onSelect={() => {}} />, {
      listRooms: async () => { throw new ApiError('HUMAN_CONTEXT_REQUIRED', 403, 'x'); },
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This token is not a human token'));
  });
});

describe('RoomList pinning', () => {
  it('floats a pinned room to the top, remembers it, and unpins', async () => {
    localStorage.clear();
    const view = renderWithClient(<RoomList selectedId={null} onSelect={() => {}} />, { listRooms: async () => rooms });
    await userEvent.click(await screen.findByRole('button', { name: 'Pin ops' }));
    const names = () => screen.getAllByRole('button').filter((b) => b.classList.contains('room-btn')).map((b) => b.querySelector('.room-btn__name')?.textContent);
    expect(screen.getByRole('navigation', { name: 'Pinned rooms' }).textContent).toContain('ops');
    expect(names()).toEqual(['ops', 'build']);
    expect(JSON.parse(localStorage.getItem('sigil.pins') ?? '[]')).toEqual(['room_2']);
    view.unmount();
    renderWithClient(<RoomList selectedId={null} onSelect={() => {}} />, { listRooms: async () => rooms });
    await userEvent.click(await screen.findByRole('button', { name: 'Unpin ops' }));
    expect(names()).toEqual(['build', 'ops']);
    localStorage.clear();
  });

  it('shows an agent face, a working dot, and the latest text', async () => {
    const members: Member[] = [
      { endpoint_id: 'ep_claude', role: 'member', response_mode: 'joins', added_at: 't', invokable_by: 'owner', owner_id: 'h', display_name: 'Claude' },
    ];
    const item: HistoryItem = {
      room_seq: '4',
      message_id: 'm1',
      canonical_bytes: null,
      display_name: 'Claude',
      envelope: {
        message_id: 'm1',
        message_type: 'room.message',
        sender: { endpoint_id: 'ep_claude', owner_id: 'h' },
        body: { text: 'shipped the fix' },
        created_at: '2026-11-27T15:00:00Z',
      },
    };
    renderWithClient(<RoomList selectedId={null} onSelect={() => {}} />, {
      listRooms: async () => rooms,
      listMembers: async () => members,
      listInvocations: async () => [{ invocation_id: 'i1', endpoint_id: 'ep_claude', status: 'running', subject_human_id: 'h' }],
      historyBefore: async () => ({ code: 'OK', items: [item], next_after_seq: '4', has_older: false }),
    });
    const build = await screen.findByRole('button', { name: /^build/ });
    await waitFor(() => expect(build.querySelector('.sender-avatar')).toHaveTextContent('CL'));
    expect(build).toHaveTextContent('Claude: shipped the fix');
    await waitFor(() => expect(build.querySelector('.working-dot')).not.toBeNull());
    expect(build.querySelector('time')).toHaveAttribute('dateTime', '2026-11-27T15:00:00Z');
  });

  it('does not select a room when its pin is clicked', async () => {
    localStorage.clear();
    const onSelect = vi.fn();
    renderWithClient(<RoomList selectedId={null} onSelect={onSelect} />, { listRooms: async () => rooms });
    await userEvent.click(await screen.findByRole('button', { name: 'Pin build' }));
    expect(onSelect).not.toHaveBeenCalled();
    localStorage.clear();
  });
});
