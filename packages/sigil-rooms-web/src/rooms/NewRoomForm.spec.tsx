import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { renderWithClient } from '../testUtils';
import { NewRoomForm } from './NewRoomForm';

const room = { conversation_id: 'room_9', workspace_id: 'ws', name: 'fresh', description: null, created_at: 't', max_agent_turns: 6 };

describe('NewRoomForm', () => {
  it('creates a trimmed-name room, refreshes the list, and reports the new id', async () => {
    const createRoom = vi.fn(async () => room);
    const onCreated = vi.fn();
    const { queryClient } = renderWithClient(<NewRoomForm onCreated={onCreated} />, { createRoom });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await userEvent.type(screen.getByLabelText('New room name'), '  fresh  ');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('room_9'));
    expect(createRoom).toHaveBeenCalledWith('fresh');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['rooms'] });
    expect(screen.getByLabelText('New room name')).toHaveValue('');
  });

  it('keeps Create disabled for a blank name', () => {
    renderWithClient(<NewRoomForm onCreated={() => {}} />, { createRoom: vi.fn() });
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('shows a readable error when the name is taken', async () => {
    const onCreated = vi.fn();
    renderWithClient(<NewRoomForm onCreated={onCreated} />, {
      createRoom: async () => { throw new ApiError('ROOM_NAME_TAKEN', 409, 'x'); },
    });
    await userEvent.type(screen.getByLabelText('New room name'), 'dup');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(onCreated).not.toHaveBeenCalled();
  });
});
