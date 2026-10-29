import type { HistoryItem, Member } from '../api/types';
import type { Row } from './mergeRows';
import { formatMentionText, roomMemberName } from './resolveMentions';
import { previewText } from './threads';
import type { LoginFor, NameFor } from './useContacts';

function Stamp({ at }: { at: string }) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return <time dateTime={at}>{date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>;
}

export function RowView({
  row,
  sender,
  nameFor,
  loginFor,
  members = [],
  replies = 0,
  latestReplies = [],
  onReply,
  onContinue,
}: {
  row: Row;
  sender: string | null;
  nameFor?: NameFor;
  loginFor?: LoginFor;
  members?: Member[];
  replies?: number;
  latestReplies?: HistoryItem[];
  onReply?: () => void;
  onContinue?: (threadRootId: string) => void;
}) {
  if (row.pending) {
    return (
      <li data-mine="true" data-pending={row.pending.status}>
        <span className="text">{row.pending.text}</span>
        <em className="status">{row.pending.status === 'failed' ? `Failed: ${row.pending.error ?? 'send error'}` : 'Sending…'}</em>
      </li>
    );
  }
  const envelope = row.item!.envelope;
  if (envelope.message_type === 'room.event') {
    const { kind, reason, thread_root_id: threadRootId } = envelope.body;
    return (
      <li data-kind="event">
        <em>{kind}{reason ? `: ${reason}` : ''}</em>
        {kind === 'agent_cap_reached' && onContinue && threadRootId ? (
          <div className="row-actions">
            <button type="button" className="ghost" onClick={() => onContinue(threadRootId)}>Continue</button>
          </div>
        ) : null}
      </li>
    );
  }
  const mine = sender !== null && envelope.sender.endpoint_id === sender;
  const senderName = members.length > 0
    ? roomMemberName({ endpoint_id: envelope.sender.endpoint_id, display_name: row.item!.display_name ?? '' }, members, nameFor, loginFor)
    : nameFor?.(envelope.sender.endpoint_id, row.item!.display_name) || row.item!.display_name || envelope.sender.endpoint_id;
  return (
    <li data-mine={mine ? 'true' : undefined}>
      <div className="meta">
        <small className="sender">{senderName}</small>
        <Stamp at={envelope.created_at} />
      </div>
      <span className="text">{formatMentionText(envelope.body.text, nameFor, members)}</span>
      {latestReplies.length > 0 && onReply ? (
        <button type="button" className="reply-preview" onClick={onReply}>
          {latestReplies.map((reply) => (
            <span key={reply.message_id} className="reply-preview-item">
              <span className="reply-preview-meta">
                <span className="reply-preview-sender">
                  {members.length > 0
                    ? roomMemberName({ endpoint_id: reply.envelope.sender.endpoint_id, display_name: reply.display_name ?? '' }, members, nameFor, loginFor)
                    : nameFor?.(reply.envelope.sender.endpoint_id, reply.display_name) || reply.display_name || reply.envelope.sender.endpoint_id}
                </span>
                <Stamp at={reply.envelope.created_at} />
              </span>
              <span className="reply-preview-text">{previewText(reply.envelope.body.text, nameFor, members)}</span>
            </span>
          ))}
        </button>
      ) : null}
      {onReply ? (
        <div className="row-actions">
          <button type="button" className="ghost" onClick={onReply}>Reply</button>
          {replies > 0 ? (
            <button type="button" className="ghost" onClick={onReply}>{replies} {replies === 1 ? 'reply' : 'replies'}</button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
