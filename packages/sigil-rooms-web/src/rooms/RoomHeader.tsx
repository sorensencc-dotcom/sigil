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
  const { client } = useAuth();
  const members = useMembers(roomId);
  const [showRoster, setShowRoster] = useState(false);
  const manager = isManager(members.data ?? [], sender);
  const stop = useMutation({
    mutationFn: () => client.stopRoom(roomId),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone();
    },
  });
  return (
    <header className="room-header">
      <RenameTitle roomId={roomId} name={name} canRename={manager} onGone={onGone} />
      <div className="room-actions">
        <button type="button" className="ghost" aria-expanded={showRoster} onClick={() => setShowRoster((open) => !open)}>Roster</button>
        <button type="button" className="danger" disabled={stop.isPending} onClick={() => stop.mutate()}>Stop</button>
      </div>
      <ErrorBanner error={stop.error} />
      {showRoster ? <RosterPanel roomId={roomId} members={members.data ?? []} manager={manager} /> : null}
    </header>
  );
}
