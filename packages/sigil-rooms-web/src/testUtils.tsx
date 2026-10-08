import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { ApiClient } from './api/client';
import { TestAuthProvider } from './auth/AuthContext';

export function renderWithClient(ui: ReactElement, client: Partial<ApiClient>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapped = (
    <QueryClientProvider client={queryClient}>
      <TestAuthProvider client={client as ApiClient}>{ui}</TestAuthProvider>
    </QueryClientProvider>
  );
  return { queryClient, ...render(wrapped) };
}
