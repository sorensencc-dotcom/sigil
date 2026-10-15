import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../errors/ErrorBanner';
import { NewRoomForm } from './NewRoomForm';
import { usePins } from './usePins';

export function RoomList({ selectedId, onSelect }: { selectedId: string | null; onSelect: (roomId: string) => void }) {
  const { client, mode, session } = useAuth();
  // Cookie mode: only the operator creates rooms; the relay enforces the same rule.
  const canCreate = mode === 'token' || session?.is_operator === true;
  const query = useQuery({ queryKey: ['rooms'], queryFn: () => client.listRooms() });
  const { pins, toggle } = usePins();
  const rooms = [...(query.data ?? [])].sort((a, b) => Number(pins.includes(b.conversation_id)) - Number(pins.includes(a.conversation_id)));
  let list;
  if (query.error) list = <ErrorBanner error={query.error} />;
  else if (query.isLoading) list = <p>Loading rooms…</p>;
  else if (rooms.length === 0) list = <p>No rooms yet.</p>;
  else {
    list = (
      <nav aria-label="Rooms">
        <ul>
          {rooms.map((room) => (
            <li key={room.conversation_id}>
              <button className="room-btn" aria-current={room.conversation_id === selectedId} onClick={() => onSelect(room.conversation_id)}>
                {room.name}
              </button>
              <button
                className="pin"
                aria-label={`${pins.includes(room.conversation_id) ? 'Unpin' : 'Pin'} ${room.name}`}
                aria-pressed={pins.includes(room.conversation_id)}
                onClick={() => toggle(room.conversation_id)}
              >
                {pins.includes(room.conversation_id) ? '★' : '☆'}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    );
  }
  return (
    <>
      {canCreate ? <NewRoomForm onCreated={onSelect} /> : null}
      {list}
    </>
  );
}
