import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';

export const membersKey = (roomId: string) => ['room', roomId, 'members'] as const;

export function useMembers(roomId: string) {
  const { client } = useAuth();
  return useQuery({ queryKey: membersKey(roomId), queryFn: () => client.listMembers(roomId) });
}
