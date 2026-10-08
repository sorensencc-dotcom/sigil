import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { fetchHistory, historyKey } from './historyQuery';

export function useHistory(roomId: string) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: historyKey(roomId), queryFn: () => fetchHistory(client, queryClient, roomId) });
  return { items: query.data ?? [], isLoading: query.isLoading, error: query.error, refetch: query.refetch };
}
