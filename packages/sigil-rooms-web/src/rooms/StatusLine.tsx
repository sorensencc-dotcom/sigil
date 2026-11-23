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
    refetchInterval: (query) => {
      if (query.state.fetchStatus !== 'idle') return false;
      if (query.state.status === 'error') return 15_000;
      return query.state.data?.some((row) => row.status === 'queued' || row.status === 'running') ? 2_000 : false;
    },
  });
  const stop = useMutation({
    mutationFn: () => client.stopRoom(roomId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['room', roomId, 'invocations'] }),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone();
    },
  });
  const working = (invocations.data ?? []).filter((row) => row.status === 'queued' || row.status === 'running');
  const memberList = members.data ?? [];
  const canStop = session?.human_id != null && working.some((row) =>
    row.subject_human_id === session.human_id || memberList.some((member) => member.endpoint_id === row.endpoint_id && member.owner_id === session.human_id),
  );
  if (working.length === 0 && !invocations.error && !stop.error && !invocations.isPending) return null;
  const stopLabel = mode === 'cookie' ? 'Stop my runs' : 'Stop';
  return (
    <div className="status-line">
      {invocations.isPending ? (
        <div role="status" aria-live="polite">Checking room activity…</div>
      ) : working.length > 0 ? (
        <div role="status" aria-live="polite">
          <span>Working: {working.map((row) => memberList.find((member) => member.endpoint_id === row.endpoint_id)?.display_name || row.endpoint_id).join(', ')}</span>
          {canStop ? <button type="button" className="danger" disabled={stop.isPending} onClick={() => stop.mutate()}>{stopLabel}</button> : null}
        </div>
      ) : null}
      <ErrorBanner error={invocations.error} />
      <ErrorBanner error={stop.error} />
    </div>
  );
}
