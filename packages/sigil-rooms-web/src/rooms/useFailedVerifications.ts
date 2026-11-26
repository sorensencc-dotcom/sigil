import { notifyManager, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { VerifyResult } from '../verify/verifyRow';

function failedIds(queryClient: QueryClient): string {
  const ids: string[] = [];
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ['verify'] })) {
    const data = query.state.data as VerifyResult | undefined;
    if (data?.state === 'failed') ids.push(String(query.queryKey[1]));
  }
  return ids.sort().join('\n');
}

// Message ids whose signature check (useVerification, keyed ['verify', message_id, ...]) already
// failed. It reads the shared query cache and starts no key fetch, so only rows someone has
// inspected can carry a failed flag.
export function useFailedVerifications(): ReadonlySet<string> {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(() => notifyManager.schedule(onChange)),
    [queryClient],
  );
  const snapshot = useSyncExternalStore(subscribe, () => failedIds(queryClient));
  return useMemo(() => new Set(snapshot ? snapshot.split('\n') : []), [snapshot]);
}
