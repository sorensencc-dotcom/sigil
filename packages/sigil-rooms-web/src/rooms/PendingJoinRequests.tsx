import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../errors/ErrorBanner';

// The requester's side of #272: rooms they asked to join, with Withdraw.
// A declined request shows once more so the person is not left waiting.
export const ownJoinRequestsKey = ['join-requests'] as const;

export function PendingJoinRequests() {
  const { client, mode } = useAuth();
  const queryClient = useQueryClient();
  const supported = mode === 'cookie' && typeof client.listOwnJoinRequests === 'function';
  const mine = useQuery({ queryKey: ownJoinRequestsKey, queryFn: () => client.listOwnJoinRequests!(), enabled: supported });
  const withdraw = useMutation({
    mutationFn: (requestId: string) => client.withdrawJoinRequest!(requestId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ownJoinRequestsKey }),
  });
  if (!supported) return null;
  const weekAgo = Date.now() - 7 * 24 * 3600_000;
  const items = (mine.data ?? []).filter((item) => item.status === 'pending'
    || (item.status === 'declined' && item.decided_at !== null && new Date(item.decided_at).getTime() > weekAgo)).slice(0, 5);
  if (items.length === 0 && !mine.error && !withdraw.error) return null;
  return (
    <section className="pending-joins" aria-label="Your join requests">
      <ul>
        {items.map((item) => (
          <li key={item.request_id}>
            {item.status === 'pending' ? (
              <>
                <span>Waiting for the owner of {item.room_name}</span>
                <button type="button" className="ghost" disabled={withdraw.isPending} onClick={() => withdraw.mutate(item.request_id)}>Withdraw</button>
              </>
            ) : (
              <span>Not accepted into {item.room_name}</span>
            )}
          </li>
        ))}
      </ul>
      <ErrorBanner error={mine.error ?? withdraw.error} />
    </section>
  );
}
