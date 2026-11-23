import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../errors/ErrorBanner';
import { RenameTitle } from './RenameTitle';
import { RosterPanel } from './RosterPanel';
import { TrustSummary } from './TrustSummary';
import { isManager } from './roles';
import { useMembers } from './useMembers';

export function RoomHeader({ roomId, name, purpose, sender, onGone }: { roomId: string; name: string; purpose?: string | null; sender: string | null; onGone: () => void }) {
  const { client, mode, session } = useAuth();
  const members = useMembers(roomId);
  const [openPanel, setOpenPanel] = useState<'roster' | 'trust' | null>(null);
  const manager = isManager(members.data ?? [], sender);
  const stop = useMutation({
    mutationFn: () => client.stopRoom(roomId),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone();
    },
  });
  // Cookie mode: the operator stops the room; everyone else stops only their own runs (same endpoint).
  const stopLabel = mode === 'cookie' ? (session?.is_operator ? 'Stop room' : 'Stop my runs') : 'Stop';
  return (
    <header className="room-header">
      <div className="room-heading">
        <RenameTitle roomId={roomId} name={name} canRename={manager} onGone={onGone} />
        {purpose ? <p className="room-purpose">{purpose}</p> : null}
      </div>
      <div className="room-actions">
        <button type="button" className="ghost" aria-expanded={openPanel === 'roster'} onClick={() => setOpenPanel((open) => open === 'roster' ? null : 'roster')}>Roster</button>
        <button type="button" className="ghost" aria-expanded={openPanel === 'trust'} onClick={() => setOpenPanel((open) => open === 'trust' ? null : 'trust')}>Trust</button>
        <button type="button" className="danger" disabled={stop.isPending} onClick={() => stop.mutate()}>{stopLabel}</button>
      </div>
      <ErrorBanner error={stop.error} />
      {openPanel === 'roster' ? <RosterPanel roomId={roomId} members={members.data ?? []} manager={manager} viewer={sender} onGone={onGone} /> : null}
      {openPanel === 'trust' ? <TrustSummary /> : null}
    </header>
  );
}
