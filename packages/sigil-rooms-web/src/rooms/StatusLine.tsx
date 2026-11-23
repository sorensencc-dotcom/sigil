import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../errors/ErrorBanner';
import { useMembers } from './useMembers';

export function StatusLine({ roomId, onGone }: { roomId: string; onGone: () => void }) {
  const { client, mode, session } = useAuth();
  const queryClient = useQueryClient();
  const members = useMembers(roomId);
  const invocations = useQuery({
    queryKey: ['room', roomId, 'invocations'],
    queryFn: () => client.listInvocations(roomId),
    refetchInterval: (query) => (query.state.data?.some((row) => row.status === 'queued' || row.status === 'running') ? 2_000 : false),
  });
  const stop = useMutation({
    mutationFn: () => client.stopRoom(roomId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['room', roomId, 'invocations'] }),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone();
    },
  });
  const working = (invocations.data ?? []).filter((row) => row.status === 'queued' || row.status === 'running');
  if (working.length === 0 && !invocations.error && !stop.error) return null;
  // Cookie mode: the operator stops the room; everyone else stops only their own runs.
  const stopLabel = mode === 'cookie' ? (session?.is_operator ? 'Stop room' : 'Stop my runs') : 'Stop';
  const memberList = members.data ?? [];
  return (
    <div className="status-line">
      {working.length > 0 ? (
        <div role="status" aria-live="polite">
          <span>Working: {working.map((row) => memberList.find((member) => member.endpoint_id === row.endpoint_id)?.display_name || row.endpoint_id).join(', ')}</span>
          <button type="button" className="danger" disabled={stop.isPending} onClick={() => stop.mutate()}>{stopLabel}</button>
        </div>
      ) : null}
      <ErrorBanner error={invocations.error} />
      <ErrorBanner error={stop.error} />
    </div>
  );
}
