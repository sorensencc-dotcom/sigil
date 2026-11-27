import { useQuery } from '@tanstack/react-query';
import type { HistoryItem, Room } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../errors/ErrorBanner';
import { NewRoomForm } from './NewRoomForm';
import { senderKind, senderMonogram, senderAvatarColor } from './SenderChip';
import { useMembers } from './useMembers';
import { usePins } from './usePins';

function latestText(items: HistoryItem[]): { sender: string; text: string; at: string } | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const text = item?.envelope.body.text?.trim();
    if (item && text) {
      return { sender: item.display_name?.trim() || item.envelope.sender.endpoint_id, text, at: item.envelope.created_at };
    }
  }
  return null;
}

function RoomRow({
  room,
  selected,
  pinned,
  onSelect,
  onTogglePin,
}: {
  room: Room;
  selected: boolean;
  pinned: boolean;
  onSelect: (roomId: string) => void;
  onTogglePin: (roomId: string) => void;
}) {
  const { client } = useAuth();
  const members = useMembers(room.conversation_id);
  const invocations = useQuery({
    queryKey: ['room', room.conversation_id, 'invocations'],
    queryFn: () => client.listInvocations(room.conversation_id),
    enabled: typeof client.listInvocations === 'function',
    staleTime: 15_000,
  });
  const latest = useQuery({
    queryKey: ['room', room.conversation_id, 'preview'],
    queryFn: () => client.historyBefore(room.conversation_id, 'latest', 8),
    enabled: typeof client.historyBefore === 'function',
    staleTime: 15_000,
  });
  const faces = (members.data ?? []).filter((member) => senderKind(member.endpoint_id, members.data ?? []) !== 'unknown').slice(0, 3);
  const working = (invocations.data ?? []).some((row) => row.status === 'queued' || row.status === 'running');
  const preview = latest.data?.items ? latestText(latest.data.items) : null;
  return (
    <li>
      <button className="room-btn" aria-current={selected} onClick={() => onSelect(room.conversation_id)}>
        {faces.length > 0 ? (
          <span className="avatar-stack" aria-hidden="true">
            {faces.map((member) => (
              <span
                key={member.endpoint_id}
                className="sender-avatar"
                data-sender-kind={senderKind(member.endpoint_id, members.data ?? [])}
                data-color={senderAvatarColor(member.endpoint_id)}
              >
                {senderMonogram(member.endpoint_id)}
              </span>
            ))}
          </span>
        ) : null}
        <span className="room-btn__name">{room.name}</span>
        {working ? <span className="working-dot" title="Working" /> : null}
        {room.description ? <span className="room-btn__purpose">{room.description}</span> : null}
        {preview ? <span className="room-btn__preview">{preview.sender}: {preview.text}</span> : null}
        {preview ? <time dateTime={preview.at}>{new Date(preview.at).toLocaleString()}</time> : null}
      </button>
      <button
        className="pin"
        aria-label={`${pinned ? 'Unpin' : 'Pin'} ${room.name}`}
        aria-pressed={pinned}
        onClick={() => onTogglePin(room.conversation_id)}
      >
        {pinned ? '★' : '☆'}
      </button>
    </li>
  );
}

export function RoomList({ selectedId, onSelect }: { selectedId: string | null; onSelect: (roomId: string) => void }) {
  const { client, mode, session } = useAuth();
  // Cookie mode: only the operator creates rooms; the relay enforces the same rule.
  const canCreate = mode === 'token' || session?.is_operator === true;
  const query = useQuery({ queryKey: ['rooms'], queryFn: () => client.listRooms() });
  const { pins, toggle } = usePins();
  const rooms = query.data ?? [];
  const pinned = rooms.filter((room) => pins.includes(room.conversation_id));
  const rest = rooms.filter((room) => !pins.includes(room.conversation_id));
  const row = (room: Room) => (
    <RoomRow
      key={room.conversation_id}
      room={room}
      selected={room.conversation_id === selectedId}
      pinned={pins.includes(room.conversation_id)}
      onSelect={onSelect}
      onTogglePin={toggle}
    />
  );
  let list;
  if (query.error) list = <ErrorBanner error={query.error} />;
  else if (query.isLoading) list = <p>Loading rooms…</p>;
  else if (rooms.length === 0) list = <p>No rooms yet.</p>;
  else {
    list = (
      <>
        {pinned.length > 0 ? (
          <nav aria-label="Pinned rooms">
            <ul className="pinned-shelf">{pinned.map(row)}</ul>
          </nav>
        ) : null}
        <nav aria-label="Rooms">
          <ul>{rest.map(row)}</ul>
        </nav>
      </>
    );
  }
  return (
    <>
      {canCreate ? <NewRoomForm onCreated={onSelect} /> : null}
      {list}
    </>
  );
}
