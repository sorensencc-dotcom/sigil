import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { ApiClient } from './api/client';
import { TestAuthProvider } from './auth/AuthContext';

export function renderWithClient(ui: ReactElement, client: Partial<ApiClient>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const api: Partial<ApiClient> = {
    ...client,
    historyBefore: client.historyBefore ?? (async (roomId, beforeSeq, limit) => {
      if (!client.history) return { code: 'OK', items: [], next_after_seq: '0', has_older: false };
      const page = await client.history(roomId, beforeSeq === 'latest' ? '0' : beforeSeq, limit);
      return { ...page, has_older: false };
    }),
    searchHistory: client.searchHistory ?? (async () => ({ code: 'OK', items: [], next_before_seq: null, has_more: false })),
    listApprovals: client.listApprovals ?? (async () => []),
  };
  const wrapped = (
    <QueryClientProvider client={queryClient}>
      <TestAuthProvider client={api as ApiClient}>{ui}</TestAuthProvider>
    </QueryClientProvider>
  );
  return { queryClient, ...render(wrapped) };
}
