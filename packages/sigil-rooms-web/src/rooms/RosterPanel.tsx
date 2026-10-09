import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import type { Member, ResponseMode } from '../api/types';
import { ErrorBanner } from '../errors/ErrorBanner';
import { membersKey } from './useMembers';

const MODES: ResponseMode[] = ['joins', 'mentions_only', 'router'];

export function RosterPanel({ roomId, members, manager, onGone }: { roomId: string; members: Member[]; manager: boolean; onGone: () => void }) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const setMode = useMutation({
    mutationFn: ({ endpointId, mode }: { endpointId: string; mode: ResponseMode }) => client.setResponseMode(roomId, endpointId, mode),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone();
    },
    // Refetch on success and on failure: a refusal means the roster the user sees is stale.
    onSettled: () => queryClient.invalidateQueries({ queryKey: membersKey(roomId) }),
  });
  return (
    <section className="roster" aria-label="Roster">
      <ul>
        {members.map((member) => (
          <li key={member.endpoint_id}>
            <span className="member-id">{member.endpoint_id}</span>
            <span className="badge">{member.role}</span>
            {member.response_mode !== null ? (
              manager ? (
                <select
                  aria-label={`Response mode for ${member.endpoint_id}`}
                  value={member.response_mode}
                  disabled={setMode.isPending}
                  onChange={(event) => setMode.mutate({ endpointId: member.endpoint_id, mode: event.target.value as ResponseMode })}
                >
                  {MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                </select>
              ) : (
                <span className="badge">{member.response_mode}</span>
              )
            ) : null}
          </li>
        ))}
      </ul>
      <ErrorBanner error={setMode.error} />
    </section>
  );
}
