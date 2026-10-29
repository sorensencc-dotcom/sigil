import type { HistoryItem } from '../api/types';
import type { Row } from './mergeRows';

function Stamp({ at }: { at: string }) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return <time dateTime={at}>{date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>;
}

const PREVIEW_MAX = 120;

function previewLabel(item: HistoryItem): string {
  return item.display_name || item.envelope.sender.endpoint_id;
}

function previewText(text: string | undefined): string {
  const value = (text ?? '').trim();
  if (value.length <= PREVIEW_MAX) return value;
  return `${value.slice(0, PREVIEW_MAX - 1)}…`;
}

export function RowView({
  row,
  sender,
  replies = 0,
  latestReply,
  onReply,
  onContinue,
}: {
  row: Row;
  sender: string | null;
  replies?: number;
  latestReply?: HistoryItem | null;
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
  const preview = latestReply ?? null;
  return (
    <li data-mine={mine ? 'true' : undefined}>
      <div className="meta">
        <small className="sender">{row.item!.display_name || envelope.sender.endpoint_id}</small>
        <Stamp at={envelope.created_at} />
      </div>
      <span className="text">{envelope.body.text}</span>
      {preview && onReply ? (
        <button type="button" className="reply-preview" onClick={onReply}>
          <span className="reply-preview-sender">{previewLabel(preview)}</span>
          <span className="reply-preview-text">{previewText(preview.envelope.body.text)}</span>
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
