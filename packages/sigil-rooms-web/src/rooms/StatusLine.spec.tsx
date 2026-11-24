import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient } from '../api/client';
import type { Member, Session } from '../api/types';
import { TestAuthProvider } from '../auth/AuthContext';
import { clearToken, setSender } from '../auth/tokenStore';
import { StatusLine } from './StatusLine';

const members: Member[] = [
  { endpoint_id: 'ep_web', role: 'owner', response_mode: null, added_at: 't', invokable_by: 'owner', owner_id: null, display_name: 'Web' },
  { endpoint_id: 'ep_agent', role: 'member', response_mode: 'joins', added_at: 't', invokable_by: 'owner', owner_id: 'h1', display_name: 'Claude' },
];
const session: Session = { human_id: 'h1', endpoint_id: 'ep_web', display_name: 'Web', is_operator: false };
const ownAgentWork = { invocation_id: 'i1', endpoint_id: 'ep_agent', status: 'running' as const, subject_human_id: 'h2' };
const otherWork = { invocation_id: 'i2', endpoint_id: 'ep_other', status: 'running' as const, subject_human_id: 'h2' };
const startedByMe = { invocation_id: 'i3', endpoint_id: 'ep_other', status: 'running' as const, subject_human_id: 'h1' };

function renderStatusLine(client: Partial<ApiClient>, initialInvocations?: unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (initialInvocations !== undefined) queryClient.setQueryData(['room', 'room_1', 'invocations'], initialInvocations);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TestAuthProvider client={client as ApiClient} mode="cookie" session={session}>
        <StatusLine roomId="room_1" onGone={() => {}} />
      </TestAuthProvider>
    </QueryClientProvider>,
  );
  return { queryClient, ...view };
}

describe('StatusLine', () => {
  afterEach(() => {
    vi.useRealTimers();
    clearToken();
  });

  it('names the working agent exactly and shows Stop for work on an owned endpoint', async () => {
    const client = {
      listMembers: vi.fn(async () => members),
      listInvocations: vi.fn(async () => [ownAgentWork]),
      stopRoom: vi.fn(async () => ({ code: 'OK', cancelled: 1 })),
    };
    renderStatusLine(client);
    expect(await screen.findByText(/^Working: Claude$/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Stop my runs' }));
    expect(client.stopRoom).toHaveBeenCalledWith('room_1');
  });

  it('keeps Stop hidden when active work belongs to another human', async () => {
    renderStatusLine({
      listMembers: vi.fn(async () => members.map((member) => ({ ...member, owner_id: 'h2' }))),
      listInvocations: vi.fn(async () => [otherWork]),
    });
    expect(await screen.findByText(/^Working: ep_other$/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop my runs' })).toBeNull();
  });

  it('shows Stop for a chain started by this human', async () => {
    renderStatusLine({
      listMembers: vi.fn(async () => members.map((member) => ({ ...member, owner_id: 'h2' }))),
      listInvocations: vi.fn(async () => [startedByMe]),
    });
    expect(await screen.findByRole('button', { name: 'Stop my runs' })).toBeInTheDocument();
  });

  it('keeps Stop available for token-mode users while work is active', async () => {
    setSender('ep_web');
    const client = {
      listMembers: vi.fn(async () => members),
      listInvocations: vi.fn(async () => [ownAgentWork]),
    };
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TestAuthProvider client={client as unknown as ApiClient} mode="token">
          <StatusLine roomId="room_1" onGone={() => {}} />
        </TestAuthProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('stays hidden only after the idle invocation query resolves', async () => {
    const client = {
      listMembers: vi.fn(async () => members),
      listInvocations: vi.fn(async () => []),
    };
    const { queryClient } = renderStatusLine(client);
    await waitFor(() => expect(queryClient.getQueryState(['room', 'room_1', 'invocations'])?.status).toBe('success'));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop my runs' })).toBeNull();
  });

  it('shows a pending status while the first invocation request is unresolved', async () => {
    let finish!: (rows: typeof ownAgentWork[]) => void;
    renderStatusLine({
      listMembers: vi.fn(async () => members),
      listInvocations: vi.fn(() => new Promise<typeof ownAgentWork[]>((resolve) => { finish = resolve; })),
    });
    expect(screen.getByText('Checking room activity…')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => finish([]));
    await waitFor(() => expect(screen.queryByText('Checking room activity…')).toBeNull());
  });

  it('retries after the initial invocation request fails', async () => {
    vi.useFakeTimers();
    const client = {
      listMembers: vi.fn(async () => members),
      listInvocations: vi.fn().mockRejectedValueOnce(new ApiError('NETWORK', 0, 'offline')).mockResolvedValue([]),
    };
    const { queryClient } = renderStatusLine(client);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(queryClient.getQueryState(['room', 'room_1', 'invocations'])?.status).toBe('error');
    expect(client.listInvocations).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
    expect(client.listInvocations).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(client.listInvocations).toHaveBeenCalledTimes(2);
  });

  it('backs off after a failed poll while retaining the active status', async () => {
    vi.useFakeTimers();
    const client = {
      listMembers: vi.fn(async () => members),
      listInvocations: vi.fn().mockResolvedValueOnce([ownAgentWork]).mockRejectedValue(new ApiError('NETWORK', 0, 'offline')),
    };
    const { queryClient } = renderStatusLine(client);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(queryClient.getQueryState(['room', 'room_1', 'invocations'])?.status).toBe('success');
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(client.listInvocations).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryState(['room', 'room_1', 'invocations'])?.status).toBe('error');
    expect(screen.getByText(/^Working: Claude$/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(client.listInvocations).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(12_999); });
    expect(client.listInvocations).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(client.listInvocations).toHaveBeenCalledTimes(3);
  });

  it('shows an invocation fetch failure', async () => {
    renderStatusLine({
      listMembers: vi.fn(async () => members),
      listInvocations: vi.fn(async () => { throw new ApiError('NETWORK', 0, 'offline'); }),
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('returns to the room list when Stop reports that the room is gone', async () => {
    const onGone = vi.fn();
    const client = {
      listMembers: vi.fn(async () => members),
      listInvocations: vi.fn(async () => [{ ...ownAgentWork, status: 'queued' as const }]),
      stopRoom: vi.fn(async () => { throw new ApiError('ROOM_NOT_FOUND', 404, 'gone'); }),
    };
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
        <TestAuthProvider client={client as unknown as ApiClient} mode="cookie" session={session}>
          <StatusLine roomId="room_1" onGone={onGone} />
        </TestAuthProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Stop my runs' }));
    await waitFor(() => expect(onGone).toHaveBeenCalled());
  });
});
