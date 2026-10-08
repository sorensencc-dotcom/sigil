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
    await userEvent.click(await screen.findByRole('button', { name: /build/ }));
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
