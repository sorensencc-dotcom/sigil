import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { renderWithClient } from '../testUtils';
import { RenameTitle } from './RenameTitle';

const room = { conversation_id: 'room_1', workspace_id: 'ws', name: 'renamed', description: null, created_at: 't', max_agent_turns: 6 };

describe('RenameTitle', () => {
  it('hides the rename button from non-managers', () => {
    renderWithClient(<RenameTitle roomId="room_1" name="build" canRename={false} onGone={() => {}} />, {});
    expect(screen.getByText('build')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename room' })).toBeNull();
  });

  it('renames with a trimmed name and refreshes the room list', async () => {
    const renameRoom = vi.fn(async () => room);
    const { queryClient } = renderWithClient(<RenameTitle roomId="room_1" name="build" canRename onGone={() => {}} />, { renameRoom });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await userEvent.click(screen.getByRole('button', { name: 'Rename room' }));
    const input = screen.getByLabelText('Room name');
    await userEvent.clear(input);
    await userEvent.type(input, '  renamed  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(renameRoom).toHaveBeenCalledWith('room_1', 'renamed'));
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['rooms'] }));
    expect(screen.queryByLabelText('Room name')).toBeNull();
  });

  it('keeps the input open and shows the relay message on a name conflict', async () => {
    const renameRoom = vi.fn(async () => { throw new ApiError('ROOM_NAME_TAKEN', 409, 'x'); });
    renderWithClient(<RenameTitle roomId="room_1" name="build" canRename onGone={() => {}} />, { renameRoom });
    await userEvent.click(screen.getByRole('button', { name: 'Rename room' }));
    const input = screen.getByLabelText('Room name');
    await userEvent.clear(input);
    await userEvent.type(input, 'ops');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(screen.getByLabelText('Room name')).toBeInTheDocument();
  });

  it('returns to the list on ROOM_NOT_FOUND and skips the call when the name is unchanged', async () => {
    const onGone = vi.fn();
    const renameRoom = vi.fn(async () => { throw new ApiError('ROOM_NOT_FOUND', 404, 'gone'); });
    renderWithClient(<RenameTitle roomId="room_1" name="build" canRename onGone={onGone} />, { renameRoom });
    await userEvent.click(screen.getByRole('button', { name: 'Rename room' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(renameRoom).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Rename room' }));
    const input = screen.getByLabelText('Room name');
    await userEvent.clear(input);
    await userEvent.type(input, 'other');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(onGone).toHaveBeenCalled());
  });
});
