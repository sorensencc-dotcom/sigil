import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import type { Contact } from '../api/types';
import { TestAuthProvider } from '../auth/AuthContext';
import { useContacts } from './useContacts';

const contacts: Contact[] = [
  { contact_id: 'ct_1', kind: 'endpoint', login: 'ep_ada', display_name: 'Ada Contact', created_at: '', updated_at: '', endpoint_ids: ['ep_ada'] },
  { contact_id: 'ct_2', kind: 'human', login: 'usr_lee', display_name: 'Lee Contact', created_at: '', updated_at: '', endpoint_ids: ['ep_lee', 'ep_lee_alt'] },
  { contact_id: 'ct_3', kind: 'email', login: 'jo@example.com', display_name: 'Jo Email', created_at: '', updated_at: '', endpoint_ids: [] },
];

function wrapper(client: Partial<ApiClient>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestAuthProvider client={client as ApiClient}>{children}</TestAuthProvider>
    </QueryClientProvider>
  );
}

describe('useContacts', () => {
  it('loads contacts and resolves endpoint, human, fallback roster, then endpoint id', async () => {
    const listContacts = vi.fn(async () => contacts);
    const { result } = renderHook(() => useContacts(), { wrapper: wrapper({ listContacts }) });
    await waitFor(() => expect(result.current.data).toEqual(contacts));
    expect(result.current.nameFor('ep_ada', 'Roster Ada')).toBe('Ada Contact');
    expect(result.current.nameFor('ep_lee', 'Roster Lee')).toBe('Lee Contact');
    expect(result.current.nameFor('ep_email')).toBe('ep_email');
    expect(result.current.nameFor('ep_old', 'Old Name')).toBe('Old Name');
    expect(result.current.loginFor('ep_lee_alt')).toBe('usr_lee');
  });

  it('prefers an endpoint contact over a human contact', () => {
    const listContacts = vi.fn(async () => [
      ...contacts,
      { contact_id: 'ct_4', kind: 'endpoint' as const, login: 'ep_lee', display_name: 'Endpoint Lee', created_at: '', updated_at: '', endpoint_ids: ['ep_lee'] },
    ]);
    const { result } = renderHook(() => useContacts(), { wrapper: wrapper({ listContacts }) });
    return waitFor(() => expect(result.current.nameFor('ep_lee')).toBe('Endpoint Lee'));
  });
});
