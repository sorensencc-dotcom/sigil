import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { JoinRequest } from '../api/types';
import { renderWithClient } from '../testUtils';
import { JoinRequestQueue } from './JoinRequestQueue';

const pending: JoinRequest = {
  request_id: 'jreq_1', room_id: 'room_1', requester_human_id: 'hum_p', requester_endpoint_id: 'ep_p', requester_name: 'Pat',
  offered_role: 'member', status: 'pending', decided_role: null, created_at: '2030-01-02T03:04:05Z', expires_at: '2030-01-09T03:04:05Z', decided_at: null,
};

describe('JoinRequestQueue', () => {
  it('accepts with the role picked, then refetches the queue and the roster', async () => {
    const decideJoinRequest = vi.fn(async () => ({ ...pending, status: 'accepted' as const, decided_role: 'room_manager' as const }));
    const listJoinRequests = vi.fn(async () => ({ pending: [pending], decided: [] }));
    const listMembers = vi.fn(async () => []);
    renderWithClient(<JoinRequestQueue roomId="room_1" onGone={() => {}} />, { listJoinRequests, decideJoinRequest, listRoomInvites: async () => [], listMembers });
    expect(await screen.findByText('Pat')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Role for Pat'), 'room_manager');
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(decideJoinRequest).toHaveBeenCalledWith('room_1', 'jreq_1', 'accept', 'room_manager');
    await waitFor(() => expect(listJoinRequests).toHaveBeenCalledTimes(2));
  });

  it('declines with no role', async () => {
    const decideJoinRequest = vi.fn(async () => ({ ...pending, status: 'declined' as const }));
    renderWithClient(<JoinRequestQueue roomId="room_1" onGone={() => {}} />, { listJoinRequests: async () => ({ pending: [pending], decided: [] }), decideJoinRequest, listRoomInvites: async () => [] });
    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    expect(decideJoinRequest).toHaveBeenCalledWith('room_1', 'jreq_1', 'decline', undefined);
  });

  it('mints a one-time link and lists only open links with Revoke', async () => {
    const createRoomInvite = vi.fn(async () => ({ invite_id: 'inv_2', role: 'member' as const, admission: 'request' as const, link: 'https://relay.test/invite#tok', token: 'tok' }));
    const revokeRoomInvite = vi.fn(async () => {});
    renderWithClient(<JoinRequestQueue roomId="room_1" onGone={() => {}} />, {
      listJoinRequests: async () => ({ pending: [], decided: [] }),
      listRoomInvites: async () => [
        { invite_id: 'inv_1', name: 'Sam', role: 'member', admission: 'request', created_by_human_id: 'hum_o', created_at: 't', expires_at: '2030-01-03T00:00:00Z', consumed_by_human_id: null, state: 'open' },
        { invite_id: 'inv_0', name: 'Old', role: 'member', admission: 'request', created_by_human_id: 'hum_o', created_at: 't', expires_at: 't', consumed_by_human_id: 'hum_x', state: 'used' },
      ],
      createRoomInvite,
      revokeRoomInvite,
    });
    expect(await screen.findByText('No one is waiting.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Name for the invite'), 'Jo');
    await userEvent.click(screen.getByRole('button', { name: 'Create link' }));
    expect(createRoomInvite).toHaveBeenCalledWith('room_1', 'Jo', 'member');
    expect(await screen.findByLabelText('One-time invite link')).toHaveValue('https://relay.test/invite#tok');
    const open = screen.getByRole('list', { name: 'Open invite links' });
    expect(open).toHaveTextContent('Sam');
    expect(open).not.toHaveTextContent('Old');
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(revokeRoomInvite).toHaveBeenCalledWith('room_1', 'inv_1');
  });

  it('renders nothing against a client without the queue', () => {
    const { container } = renderWithClient(<JoinRequestQueue roomId="room_1" onGone={() => {}} />, {});
    expect(container).toBeEmptyDOMElement();
  });
});
