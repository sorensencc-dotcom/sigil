import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../api/client';
import type { GrantableRole, JoinRequest } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../errors/ErrorBanner';
import { membersKey } from './useMembers';

// Owners and room managers only (#272). The relay re-checks the role on every call.
export const joinRequestsKey = (roomId: string) => ['room', roomId, 'join-requests'] as const;
const invitesKey = (roomId: string) => ['room', roomId, 'invites'] as const;
const ROLE_LABEL: Record<GrantableRole, string> = { member: 'Member', room_manager: 'Room manager' };

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function PendingRow({ roomId, request, onGone }: { roomId: string; request: JoinRequest; onGone: () => void }) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const [role, setRole] = useState<GrantableRole>(request.offered_role);
  const name = request.requester_name?.trim() || 'Someone';
  const decide = useMutation({
    mutationFn: (decision: 'accept' | 'decline') => client.decideJoinRequest!(roomId, request.request_id, decision, decision === 'accept' ? role : undefined),
    onError: (error) => { if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone(); },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: joinRequestsKey(roomId) });
      void queryClient.invalidateQueries({ queryKey: membersKey(roomId) });
    },
  });
  return (
    <li>
      <span className="member-id">{name}</span>
      <span className="badge">asked {when(request.created_at)}</span>
      <label>
        Role for {name}
        <select value={role} disabled={decide.isPending} onChange={(event) => setRole(event.target.value as GrantableRole)}>
          {(['member', 'room_manager'] as const).map((value) => <option key={value} value={value}>{ROLE_LABEL[value]}</option>)}
        </select>
      </label>
      <button type="button" disabled={decide.isPending} onClick={() => decide.mutate('accept')}>Accept</button>
      <button type="button" className="ghost" disabled={decide.isPending} onClick={() => decide.mutate('decline')}>Decline</button>
      <ErrorBanner error={decide.error} />
    </li>
  );
}

export function JoinRequestQueue({ roomId, onGone }: { roomId: string; onGone: () => void }) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const supported = typeof client.listJoinRequests === 'function';
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<GrantableRole>('member');
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const queue = useQuery({ queryKey: joinRequestsKey(roomId), queryFn: () => client.listJoinRequests!(roomId), enabled: supported });
  const invites = useQuery({ queryKey: invitesKey(roomId), queryFn: () => client.listRoomInvites!(roomId), enabled: typeof client.listRoomInvites === 'function' });
  const createInvite = useMutation({
    mutationFn: () => client.createRoomInvite!(roomId, inviteName.trim(), inviteRole),
    onSuccess: ({ link, token }) => {
      setCreatedLink(link ?? `${window.location.origin}/invite#${token}`);
      setInviteName('');
      void queryClient.invalidateQueries({ queryKey: invitesKey(roomId) });
    },
    onError: (error) => { if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone(); },
  });
  const revokeInvite = useMutation({
    mutationFn: (inviteId: string) => client.revokeRoomInvite!(roomId, inviteId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: invitesKey(roomId) }),
  });
  if (!supported) return null;
  const pending = queue.data?.pending ?? [];
  const open = (invites.data ?? []).filter((invite) => invite.state === 'open');
  return (
    <section aria-label="Join requests">
      <h3>Waiting to join</h3>
      {pending.length === 0 ? <p>No one is waiting.</p> : (
        <ul>
          {pending.map((request) => <PendingRow key={request.request_id} roomId={roomId} request={request} onGone={onGone} />)}
        </ul>
      )}
      <h3>Invite a person</h3>
      <form onSubmit={(event) => { event.preventDefault(); createInvite.mutate(); }}>
        <label>
          Name for the invite
          <input value={inviteName} onChange={(event) => setInviteName(event.target.value)} maxLength={80} required />
        </label>
        <label>
          Role if accepted
          <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as GrantableRole)}>
            {(['member', 'room_manager'] as const).map((value) => <option key={value} value={value}>{ROLE_LABEL[value]}</option>)}
          </select>
        </label>
        <button type="submit" disabled={createInvite.isPending}>Create link</button>
      </form>
      <p>The link works once and expires in 24 hours. The person signs in with GitHub, then waits here until you accept.</p>
      {createdLink ? (
        <p>
          <label>One-time invite link <input className="machine-id" readOnly value={createdLink} /></label>
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(createdLink); }}>Copy link</button>
        </p>
      ) : null}
      {open.length > 0 ? (
        <ul aria-label="Open invite links">
          {open.map((invite) => (
            <li key={invite.invite_id}>
              <span className="member-id">{invite.name}</span>
              <span className="badge">expires {when(invite.expires_at)}</span>
              <button type="button" disabled={revokeInvite.isPending} onClick={() => revokeInvite.mutate(invite.invite_id)}>Revoke</button>
            </li>
          ))}
        </ul>
      ) : null}
      <ErrorBanner error={queue.error ?? invites.error ?? createInvite.error ?? revokeInvite.error} />
    </section>
  );
}
