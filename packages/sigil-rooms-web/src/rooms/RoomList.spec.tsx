import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
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
    await userEvent.click(await screen.findByRole('button', { name: 'build' }));
    expect(onSelect).toHaveBeenCalledWith('room_1');
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
    const names = () => screen.getAllByRole('button').filter((b) => /^(build|ops)$/.test(b.textContent ?? '')).map((b) => b.textContent);
    expect(names()).toEqual(['ops', 'build']);
    expect(JSON.parse(localStorage.getItem('sigil.pins') ?? '[]')).toEqual(['room_2']);
    view.unmount();
    renderWithClient(<RoomList selectedId={null} onSelect={() => {}} />, { listRooms: async () => rooms });
    await userEvent.click(await screen.findByRole('button', { name: 'Unpin ops' }));
    expect(names()).toEqual(['build', 'ops']);
    localStorage.clear();
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
