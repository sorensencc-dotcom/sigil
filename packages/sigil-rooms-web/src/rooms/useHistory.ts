import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { fetchHistory, historyKey, loadHistoryAround, loadLatestHistory, loadNewerHistory, loadOlderHistory } from './historyQuery';

export function useHistory(roomId: string) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: historyKey(roomId), queryFn: () => fetchHistory(client, queryClient, roomId) });
  const window = query.data;
  return {
    items: window?.items ?? [],
    hasOlder: window?.hasOlder ?? false,
    hasNewer: window?.hasNewer ?? false,
    atLatest: window?.atLatest ?? true,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    loadOlder: () => loadOlderHistory(client, queryClient, roomId),
    loadNewer: () => loadNewerHistory(client, queryClient, roomId),
    goToLatest: () => loadLatestHistory(client, queryClient, roomId),
    goToSequence: (seq: string) => loadHistoryAround(client, queryClient, roomId, seq),
  };
}
