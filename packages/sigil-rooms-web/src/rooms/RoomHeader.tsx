import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../errors/ErrorBanner';
import { RenameTitle } from './RenameTitle';
import { RosterPanel } from './RosterPanel';
import { isManager } from './roles';
import { useMembers } from './useMembers';

export function RoomHeader({ roomId, name, sender, onGone }: { roomId: string; name: string; sender: string | null; onGone: () => void }) {
  const { client, mode, session } = useAuth();
  const members = useMembers(roomId);
  const [showRoster, setShowRoster] = useState(false);
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
      <RenameTitle roomId={roomId} name={name} canRename={manager} onGone={onGone} />
      <div className="room-actions">
        <button type="button" className="ghost" aria-expanded={showRoster} onClick={() => setShowRoster((open) => !open)}>Roster</button>
        <button type="button" className="danger" disabled={stop.isPending} onClick={() => stop.mutate()}>{stopLabel}</button>
      </div>
      <ErrorBanner error={stop.error} />
      {showRoster ? <RosterPanel roomId={roomId} members={members.data ?? []} manager={manager} viewer={sender} onGone={onGone} /> : null}
    </header>
  );
}
