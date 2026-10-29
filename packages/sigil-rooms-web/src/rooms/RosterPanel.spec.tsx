import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { Member } from '../api/types';
import { renderWithClient } from '../testUtils';
import { RosterPanel } from './RosterPanel';

const members: Member[] = [
  { endpoint_id: 'ep_web', role: 'owner', response_mode: null, added_at: 't', invokable_by: 'owner', owner_id: 'usr_a', display_name: 'Ada' },
  { endpoint_id: 'ep_claude', role: 'member', response_mode: 'joins', added_at: 't', invokable_by: 'owner', owner_id: 'usr_a', display_name: 'ep_claude' },
  { endpoint_id: 'ep_old', role: 'member', response_mode: null, added_at: 't', invokable_by: 'owner', owner_id: 'usr_b', display_name: 'Old Bot' },
];

describe('RosterPanel', () => {
  it('shows role and mode badges and no controls for a non-manager', () => {
    renderWithClient(<RosterPanel roomId="room_1" members={members} manager={false} onGone={() => {}} />, {});
    expect(screen.getByText('ep_claude')).toBeInTheDocument();
    expect(screen.getByText('joins')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('gives a manager a mode select on agent rows only', () => {
    renderWithClient(<RosterPanel roomId="room_1" members={members} manager onGone={() => {}} />, {});
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(screen.getByLabelText('Response mode for ep_claude')).toHaveValue('joins');
  });

  it('changes the mode and refetches the roster', async () => {
    const setResponseMode = vi.fn(async () => ({ ...members[1]!, response_mode: 'mentions_only' as const }));
    const { queryClient } = renderWithClient(<RosterPanel roomId="room_1" members={members} manager onGone={() => {}} />, { setResponseMode });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await userEvent.selectOptions(screen.getByLabelText('Response mode for ep_claude'), 'mentions_only');
    await vi.waitFor(() => expect(setResponseMode).toHaveBeenCalledWith('room_1', 'ep_claude', 'mentions_only'));
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['room', 'room_1', 'members'] }));
  });

  it('shows the relay refusal and refetches when the caller is not a manager', async () => {
    const setResponseMode = vi.fn(async () => { throw new ApiError('ROUTE_NOT_AUTHORIZED', 403, 'no'); });
    const { queryClient } = renderWithClient(<RosterPanel roomId="room_1" members={members} manager onGone={() => {}} />, { setResponseMode });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await userEvent.selectOptions(screen.getByLabelText('Response mode for ep_claude'), 'router');
    expect(await screen.findByRole('alert')).toHaveTextContent('Only room managers can do this');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['room', 'room_1', 'members'] });
  });

  it('returns to the list when the room is gone', async () => {
    const onGone = vi.fn();
    const setResponseMode = vi.fn(async () => { throw new ApiError('ROOM_NOT_FOUND', 404, 'gone'); });
    renderWithClient(<RosterPanel roomId="room_1" members={members} manager onGone={onGone} />, { setResponseMode });
    await userEvent.selectOptions(screen.getByLabelText('Response mode for ep_claude'), 'router');
    await vi.waitFor(() => expect(onGone).toHaveBeenCalledOnce());
  });

  it('shows display names, falling back to the endpoint id', () => {
    renderWithClient(<RosterPanel roomId="room_1" members={members} manager={false} onGone={() => {}} />, {});
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Old Bot')).toBeInTheDocument();
    expect(screen.getByText('ep_claude')).toBeInTheDocument();
    expect(screen.queryByText('ep_web')).toBeNull();
  });

  it('uses the viewer contact name for a roster member', async () => {
    const listContacts = vi.fn(async () => [
      { contact_id: 'ct_1', kind: 'endpoint' as const, login: 'ep_web', display_name: 'Personal Ada', endpoint_ids: ['ep_web'] },
    ]);
    renderWithClient(<RosterPanel roomId="room_1" members={members} manager={false} onGone={() => {}} />, { listContacts });
    expect(await screen.findByText('Personal Ada')).toBeInTheDocument();
    expect(screen.queryByText('Ada')).toBeNull();
  });

  it('shows the invokable-by mode to everyone but the control only to the agent owner', () => {
    renderWithClient(<RosterPanel roomId="room_1" members={members} manager={false} viewer="ep_web" onGone={() => {}} />, {});
    expect(screen.getByLabelText('Invokable by for ep_claude')).toHaveValue('owner');
    renderWithClient(<RosterPanel roomId="room_1" members={members} manager={false} viewer="ep_guest" onGone={() => {}} />, {});
    expect(screen.getAllByLabelText('Invokable by for ep_claude')).toHaveLength(1);
    expect(screen.getAllByText('invokable by: owner').length).toBeGreaterThan(0);
  });

  it('posts a new invokable-by mode and refetches', async () => {
    const setInvokableBy = vi.fn(async () => ({ ...members[1]!, invokable_by: 'members' as const }));
    const { queryClient } = renderWithClient(<RosterPanel roomId="room_1" members={members} manager={false} viewer="ep_web" onGone={() => {}} />, { setInvokableBy });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await userEvent.selectOptions(screen.getByLabelText('Invokable by for ep_claude'), 'members');
    await vi.waitFor(() => expect(setInvokableBy).toHaveBeenCalledWith('room_1', 'ep_claude', 'members'));
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['room', 'room_1', 'members'] }));
  });

  it('shows report_only members as a read-only Report only label with no mode control', () => {
    const withReporter: Member[] = [
      ...members,
      { endpoint_id: 'ep_reporter', role: 'member', response_mode: 'report_only', added_at: 't', invokable_by: 'owner', owner_id: 'usr_a', display_name: 'Reporter' },
    ];
    renderWithClient(<RosterPanel roomId="room_1" members={withReporter} manager onGone={() => {}} />, {});
    expect(screen.getByText('Report only')).toBeInTheDocument();
    expect(screen.queryByLabelText('Response mode for ep_reporter')).toBeNull();
    // Editable agent still has exactly one mode select; report_only adds none.
    expect(screen.getByLabelText('Response mode for ep_claude')).toBeInTheDocument();
  });

  it('keeps mode editor options to joins, mentions_only, and router without report_only', () => {
    renderWithClient(<RosterPanel roomId="room_1" members={members} manager onGone={() => {}} />, {});
    const select = screen.getByLabelText('Response mode for ep_claude');
    const values = Array.from(select.querySelectorAll('option')).map((option) => (option as HTMLOptionElement).value);
    expect(values).toEqual(['joins', 'mentions_only', 'router']);
  });
});
