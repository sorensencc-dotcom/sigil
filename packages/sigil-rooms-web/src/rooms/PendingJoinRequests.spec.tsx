import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import type { OwnJoinRequest } from '../api/types';
import { TestAuthProvider } from '../auth/AuthContext';
import { PendingJoinRequests } from './PendingJoinRequests';

const base: OwnJoinRequest = {
  request_id: 'jreq_1', room_id: 'room_1', room_name: 'Design', requester_human_id: 'hum_me', requester_endpoint_id: 'ep_me', requester_name: null,
  offered_role: 'member', status: 'pending', decided_role: null, created_at: 't', expires_at: 't', decided_at: null,
};

function renderAs(client: Partial<ApiClient>, mode: 'cookie' | 'token' = 'cookie') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TestAuthProvider client={client as ApiClient} mode={mode} session={{ human_id: 'hum_me', endpoint_id: 'ep_me', display_name: 'Me', is_operator: false }}>
        <PendingJoinRequests />
      </TestAuthProvider>
    </QueryClientProvider>,
  );
}

describe('PendingJoinRequests', () => {
  it('shows a pending room by name and withdraws it', async () => {
    const withdrawJoinRequest = vi.fn(async () => {});
    renderAs({ listOwnJoinRequests: async () => [base], withdrawJoinRequest });
    expect(await screen.findByText('Waiting for the owner of Design')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(withdrawJoinRequest).toHaveBeenCalledWith('jreq_1');
  });

  it('shows a recent decline once and hides accepted and old requests', async () => {
    const recent = new Date(Date.now() - 3600_000).toISOString();
    const old = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    renderAs({ listOwnJoinRequests: async () => [
      { ...base, request_id: 'jreq_2', room_name: 'Ops', status: 'declined', decided_at: recent },
      { ...base, request_id: 'jreq_3', room_name: 'Old', status: 'declined', decided_at: old },
      { ...base, request_id: 'jreq_4', room_name: 'Joined', status: 'accepted', decided_at: recent, decided_role: 'member' },
    ] });
    expect(await screen.findByText('Not accepted into Ops')).toBeInTheDocument();
    expect(screen.queryByText(/Old/)).toBeNull();
    expect(screen.queryByText(/Joined/)).toBeNull();
  });

  it('stays out of token mode', () => {
    const listOwnJoinRequests = vi.fn(async () => [base]);
    const { container } = renderAs({ listOwnJoinRequests }, 'token');
    expect(container).toBeEmptyDOMElement();
    expect(listOwnJoinRequests).not.toHaveBeenCalled();
  });
});
