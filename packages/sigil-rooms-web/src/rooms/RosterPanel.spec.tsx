import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { Member } from '../api/types';
import { renderWithClient } from '../testUtils';
import { RosterPanel } from './RosterPanel';

const members: Member[] = [
  { endpoint_id: 'ep_web', role: 'owner', response_mode: null, added_at: 't' },
  { endpoint_id: 'ep_claude', role: 'member', response_mode: 'joins', added_at: 't' },
  { endpoint_id: 'ep_old', role: 'member', response_mode: null, added_at: 't' },
];

describe('RosterPanel', () => {
  it('shows role and mode badges and no controls for a non-manager', () => {
    renderWithClient(<RosterPanel roomId="room_1" members={members} manager={false} />, {});
    expect(screen.getByText('ep_claude')).toBeInTheDocument();
    expect(screen.getByText('joins')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('gives a manager a mode select on agent rows only', () => {
    renderWithClient(<RosterPanel roomId="room_1" members={members} manager />, {});
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(screen.getByLabelText('Response mode for ep_claude')).toHaveValue('joins');
  });

  it('changes the mode and refetches the roster', async () => {
    const setResponseMode = vi.fn(async () => ({ ...members[1]!, response_mode: 'mentions_only' as const }));
    const { queryClient } = renderWithClient(<RosterPanel roomId="room_1" members={members} manager />, { setResponseMode });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await userEvent.selectOptions(screen.getByLabelText('Response mode for ep_claude'), 'mentions_only');
    await vi.waitFor(() => expect(setResponseMode).toHaveBeenCalledWith('room_1', 'ep_claude', 'mentions_only'));
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['room', 'room_1', 'members'] }));
  });

  it('shows the relay refusal and refetches when the caller is not a manager', async () => {
    const setResponseMode = vi.fn(async () => { throw new ApiError('ROUTE_NOT_AUTHORIZED', 403, 'no'); });
    const { queryClient } = renderWithClient(<RosterPanel roomId="room_1" members={members} manager />, { setResponseMode });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await userEvent.selectOptions(screen.getByLabelText('Response mode for ep_claude'), 'router');
    expect(await screen.findByRole('alert')).toHaveTextContent('Only room managers can do this');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['room', 'room_1', 'members'] });
  });
});
