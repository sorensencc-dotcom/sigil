import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../errors/ErrorBanner';

export function NewRoomForm({ onCreated }: { onCreated: (roomId: string) => void }) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: (roomName: string) => client.createRoom(roomName),
    onSuccess: async (room) => {
      setName('');
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
        create.mutate(trimmed);
      }}
    >
      <input aria-label="New room name" placeholder="New room" value={name} onChange={(event) => setName(event.target.value)} />
      <button type="submit" disabled={create.isPending || !name.trim()}>Create</button>
      <ErrorBanner error={create.error} />
    </form>
  );
}
