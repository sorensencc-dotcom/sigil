import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../errors/ErrorBanner';

export function RoomList({ selectedId, onSelect }: { selectedId: string | null; onSelect: (roomId: string) => void }) {
  const { client } = useAuth();
  const query = useQuery({ queryKey: ['rooms'], queryFn: () => client.listRooms() });
  if (query.error) return <ErrorBanner error={query.error} />;
  if (query.isLoading) return <p>Loading rooms…</p>;
  const rooms = query.data ?? [];
  if (rooms.length === 0) return <p>No rooms yet.</p>;
  return (
    <nav aria-label="Rooms">
      <ul>
        {rooms.map((room) => (
          <li key={room.conversation_id}>
            <button aria-current={room.conversation_id === selectedId} onClick={() => onSelect(room.conversation_id)}>
              {room.name}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
