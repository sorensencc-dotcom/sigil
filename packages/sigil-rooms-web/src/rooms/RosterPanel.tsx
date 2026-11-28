import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import type { InvokableBy, Member, ResponseMode } from '../api/types';
import { ErrorBanner } from '../errors/ErrorBanner';
import { JoinRequestQueue } from './JoinRequestQueue';
import { membersKey } from './useMembers';
import { roomMemberName } from './resolveMentions';
import { useContacts } from './useContacts';

const MODES: ResponseMode[] = ['joins', 'mentions_only', 'router'];
const WAKE_RULE: Record<ResponseMode, string> = {
  joins: 'I can wake when mentioned, assigned a task, or picked by the router.',
  mentions_only: 'I can wake when mentioned or assigned a task.',
  router: 'I can wake to decide which agents should respond.',
  report_only: 'I report updates and never wake for room messages.',
};
const INVOKABLE: InvokableBy[] = ['owner', 'members'];

export function RosterPanel({ roomId, maxAgentTurns, members, manager, viewer = null, onGone }: { roomId: string; maxAgentTurns?: number; members: Member[]; manager: boolean; viewer?: string | null; onGone: () => void }) {
  const { client } = useAuth();
  const { nameFor, loginFor } = useContacts();
  const queryClient = useQueryClient();
  const [inviteEndpoint, setInviteEndpoint] = useState('');
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const agentInvites = useQuery({
    queryKey: ['room', roomId, 'agent-invites'],
    queryFn: () => client.listAgentRoomInvites(roomId),
    enabled: manager && typeof client.listAgentRoomInvites === 'function',
    refetchInterval: (query) => manager && (query.state.data ?? []).some((invite) => invite.state === 'pending') ? 5000 : false,
  });
  const createInvite = useMutation({
    mutationFn: () => client.createAgentRoomInvite(roomId, inviteEndpoint.trim()),
    onSuccess: ({ invite_code }) => {
      setCreatedCode(invite_code);
      setInviteEndpoint('');
      queryClient.invalidateQueries({ queryKey: ['room', roomId, 'agent-invites'] });
    },
    onError: (error) => { if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone(); },
  });
  const revokeInvite = useMutation({
    mutationFn: (inviteId: string) => client.revokeAgentRoomInvite(roomId, inviteId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['room', roomId, 'agent-invites'] }),
    onError: (error) => { if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone(); },
  });
  const setMode = useMutation({
    mutationFn: ({ endpointId, mode }: { endpointId: string; mode: ResponseMode }) => client.setResponseMode(roomId, endpointId, mode),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone();
    },
    // Refetch on success and on failure: a refusal means the roster the user sees is stale.
    onSettled: () => queryClient.invalidateQueries({ queryKey: membersKey(roomId) }),
  });
  const setInvokable = useMutation({
    mutationFn: ({ endpointId, mode }: { endpointId: string; mode: InvokableBy }) => client.setInvokableBy(roomId, endpointId, mode),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone();
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: membersKey(roomId) }),
  });
  // Only the agent's owner may change who can invoke it; the relay enforces the same rule.
  const viewerOwner = members.find((member) => member.endpoint_id === viewer)?.owner_id ?? null;
  return (
    <section className="roster" aria-label="Roster">
      {maxAgentTurns != null ? <p>Turn cap: {maxAgentTurns} agent turns per thread.</p> : null}
      <ul>
        {members.map((member) => (
          <li key={member.endpoint_id}>
            <span className="member-id">{roomMemberName(member, members, nameFor, loginFor)}</span>
            <span className="badge">{member.role}</span>
            {member.response_mode !== null ? (
              member.response_mode !== 'report_only' && manager ? (
                <select
                  aria-label={`Wake rule for ${member.endpoint_id}`}
                  value={member.response_mode}
                  disabled={setMode.isPending}
                  onChange={(event) => setMode.mutate({ endpointId: member.endpoint_id, mode: event.target.value as ResponseMode })}
                >
                  {MODES.map((mode) => <option key={mode} value={mode}>{WAKE_RULE[mode]}</option>)}
                </select>
              ) : (
                <span className="badge">{WAKE_RULE[member.response_mode]}</span>
              )
            ) : null}
            {member.response_mode !== null ? (
              viewerOwner !== null && member.owner_id === viewerOwner ? (
                <select
                  aria-label={`Invokable by for ${member.endpoint_id}`}
                  title="Who can invoke this agent. @mentions from the composer create invocations when this is set to members; the router still answers for the room owner only."
                  value={member.invokable_by}
                  disabled={setInvokable.isPending}
                  onChange={(event) => setInvokable.mutate({ endpointId: member.endpoint_id, mode: event.target.value as InvokableBy })}
                >
                  {INVOKABLE.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                </select>
              ) : (
                <span className="badge">invokable by: {member.invokable_by}</span>
              )
            ) : null}
          </li>
        ))}
      </ul>
      {manager ? <JoinRequestQueue roomId={roomId} onGone={onGone} /> : null}
      {manager ? (
        <section aria-label="Agent invites">
          <h3>Bring an agent</h3>
          <form onSubmit={(event) => { event.preventDefault(); createInvite.mutate(); }}>
            <label>
              Active agent endpoint ID
              <input value={inviteEndpoint} onChange={(event) => setInviteEndpoint(event.target.value)} maxLength={256} required />
            </label>
            <button type="submit" disabled={createInvite.isPending}>Create invite</button>
          </form>
          <p>Only the named agent can redeem this code. It expires in 15 minutes.</p>
          <p>The agent owner runs <code>sigil room join &lt;code&gt; --identity &lt;agent.identity.json&gt; --relay-url &lt;relay-origin&gt;</code>.</p>
          {createdCode ? (
            <p>
              <label>One-time invite code <input className="machine-id" readOnly value={createdCode} /></label>
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(createdCode); }}>Copy code</button>
            </p>
          ) : null}
          <ul>
            {(agentInvites.data ?? []).filter((invite) => invite.state === 'pending' || invite.state === 'connected').map((invite) => (
              <li key={invite.invite_id}>
                <span className="machine-id">{invite.endpoint_id}</span>
                <span className="badge">{invite.state}</span>
                {invite.state === 'pending' ? <button type="button" disabled={revokeInvite.isPending} onClick={() => revokeInvite.mutate(invite.invite_id)}>Revoke</button> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <ErrorBanner error={setMode.error ?? setInvokable.error ?? createInvite.error ?? revokeInvite.error ?? agentInvites.error} />
    </section>
  );
}
