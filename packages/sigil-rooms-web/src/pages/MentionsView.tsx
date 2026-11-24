import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import type { Mention } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../errors/ErrorBanner';
import { formatMentionText } from '../rooms/resolveMentions';
import { useContacts } from '../rooms/useContacts';

export const mentionsKey = ['mentions'] as const;

// The shared describeError reads "Rooms are unavailable" for this code, but rooms still work when only mentions are missing.
function MentionsError({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.code === 'DATABASE_UNAVAILABLE') {
    return <p role="alert">Mentions need the relay's database. This relay runs without one.</p>;
  }
  return <ErrorBanner error={error} />;
}

export function MentionsView({ onOpen }: { onOpen: (mention: Mention) => void }) {
  const { client } = useAuth();
  const { nameFor } = useContacts();
  const mentions = useQuery({ queryKey: mentionsKey, queryFn: () => client.listMentions() });
  const rooms = useQuery({ queryKey: ['rooms'], queryFn: () => client.listRooms() });
  const roomName = (roomId: string) => rooms.data?.find((room) => room.conversation_id === roomId)?.name ?? roomId;
  return (
    <section className="settings-page mentions-page">
      <header className="settings-header">
        <h1>Mentions</h1>
      </header>
      {mentions.error ? <MentionsError error={mentions.error} /> : null}
      {mentions.isLoading ? <p>Loading mentions…</p> : null}
      {mentions.data && mentions.data.length === 0 ? <p className="empty">No one has mentioned you yet.</p> : null}
      {mentions.data && mentions.data.length > 0 ? (
        <ul className="mention-list" aria-label="Messages that mention you">
          {mentions.data.map((mention) => (
            <li key={`${mention.conversation_id}:${mention.message_id}`}>
              <div className="meta">
                <span className="sender">{nameFor(mention.sender_endpoint_id)}</span>
                <span className="mention-room">in {roomName(mention.conversation_id)}</span>
              </div>
              <span className="text">{formatMentionText(mention.text ?? '', nameFor)}</span>
              <div className="row-actions">
                <button type="button" className="ghost" onClick={() => onOpen(mention)}>
                  Open in {roomName(mention.conversation_id)}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
