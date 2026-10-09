import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { Member } from '../api/types';
import { renderWithClient } from '../testUtils';
import { RoomHeader } from './RoomHeader';

const members: Member[] = [
  { endpoint_id: 'ep_web', role: 'owner', response_mode: null, added_at: 't' },
  { endpoint_id: 'ep_claude', role: 'member', response_mode: 'joins', added_at: 't' },
];
const listMembers = vi.fn(async () => members);

describe('RoomHeader', () => {
  it('posts Stop and disables the button while the request runs', async () => {
    let finish!: (value: { code: string; cancelled: number }) => void;
    const stopRoom = vi.fn(() => new Promise<{ code: string; cancelled: number }>((resolve) => { finish = resolve; }));
    renderWithClient(<RoomHeader roomId="room_1" name="build" sender="ep_web" onGone={() => {}} />, { listMembers, stopRoom });
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(stopRoom).toHaveBeenCalledWith('room_1');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    finish({ code: 'OK', cancelled: 0 });
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled());
  });

  it('returns to the list when Stop answers ROOM_NOT_FOUND', async () => {
    const onGone = vi.fn();
    const stopRoom = vi.fn(async () => { throw new ApiError('ROOM_NOT_FOUND', 404, 'gone'); });
    renderWithClient(<RoomHeader roomId="room_1" name="build" sender="ep_web" onGone={onGone} />, { listMembers, stopRoom });
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await vi.waitFor(() => expect(onGone).toHaveBeenCalled());
  });

  it('shows rename and editable modes to a manager, and neither before the sender is known', async () => {
    const first = renderWithClient(<RoomHeader roomId="room_1" name="build" sender="ep_web" onGone={() => {}} />, { listMembers });
    expect(await screen.findByRole('button', { name: 'Rename room' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Roster' }));
    expect(await screen.findByLabelText('Response mode for ep_claude')).toBeInTheDocument();
    first.unmount();
    renderWithClient(<RoomHeader roomId="room_1" name="build" sender={null} onGone={() => {}} />, { listMembers });
    await userEvent.click(screen.getByRole('button', { name: 'Roster' }));
    expect(await screen.findByText('ep_claude')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename room' })).toBeNull();
    expect(screen.queryByLabelText('Response mode for ep_claude')).toBeNull();
  });
});
