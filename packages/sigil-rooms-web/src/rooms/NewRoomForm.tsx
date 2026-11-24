import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../errors/ErrorBanner';

export function NewRoomForm({ onCreated }: { onCreated: (roomId: string) => void }) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const create = useMutation({
    mutationFn: ({ roomName, roomPurpose }: { roomName: string; roomPurpose?: string }) => client.createRoom(roomName, roomPurpose),
    onSuccess: async (room) => {
      setName('');
      setPurpose('');
      await queryClient.invalidateQueries({ queryKey: ['rooms'] });
      onCreated(room.conversation_id);
    },
  });
  return (
    <form
      className="new-room"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed || create.isPending) return;
        const trimmedPurpose = purpose.trim();
        create.mutate({ roomName: trimmed, roomPurpose: trimmedPurpose || undefined });
      }}
    >
      <input aria-label="New room name" placeholder="New room" value={name} onChange={(event) => setName(event.target.value)} />
      <input className="new-room-purpose" aria-label="Room purpose (optional)" placeholder="Purpose (optional)" value={purpose} onChange={(event) => setPurpose(event.target.value)} />
      <button type="submit" disabled={create.isPending || !name.trim()}>Create</button>
      <ErrorBanner error={create.error} />
    </form>
  );
}
