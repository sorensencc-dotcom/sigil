import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Member } from '../api/types';
import { renderWithClient } from '../testUtils';
import { RoomHeader } from './RoomHeader';

const members: Member[] = [
  { endpoint_id: 'ep_web', role: 'owner', response_mode: null, added_at: 't', invokable_by: 'owner', owner_id: null, display_name: 'ep_web' },
  { endpoint_id: 'ep_claude', role: 'member', response_mode: 'joins', added_at: 't', invokable_by: 'owner', owner_id: null, display_name: 'ep_claude' },
];
const listMembers = vi.fn(async () => members);

describe('RoomHeader', () => {
  it('shows the room purpose with the title', () => {
    renderWithClient(<RoomHeader roomId="room_1" name="build" purpose="the build room" sender="ep_web" onGone={() => {}} />, { listMembers });
    expect(screen.getByText('the build room')).toBeInTheDocument();
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

  it('opens an honest trust summary for any room member', async () => {
    renderWithClient(<RoomHeader roomId="room_1" name="build" sender={null} onGone={() => {}} />, { listMembers });
    await userEvent.click(screen.getByRole('button', { name: 'Trust' }));
    const summary = screen.getByRole('region', { name: 'Room trust summary' });
    expect(summary).toHaveTextContent('What is signed');
    expect(summary).toHaveTextContent('What the relay can see');
    expect(summary).toHaveTextContent('Not yet verified');
    expect(summary).toHaveTextContent('relay-custodial key');
    expect(screen.getByRole('button', { name: 'Trust' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps Stop out of the header', async () => {
    renderWithClient(<RoomHeader roomId="room_1" name="build" sender="ep_web" onGone={() => {}} />, { listMembers });
    expect(await screen.findByRole('button', { name: 'Roster' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });
});
