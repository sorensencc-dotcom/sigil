import { useMemo } from 'react';
import { getSender } from '../auth/tokenStore';
import { Composer } from './Composer';
import { mergeRows, type PendingMessage } from './mergeRows';
import { RowView } from './RowView';
import { rowsById, threadReplies } from './threads';
import { useHistory } from './useHistory';

export function ThreadPanel({
  roomId,
  rootId,
  pending,
  onSend,
  onClose,
  disabledReason,
}: {
  roomId: string;
  rootId: string;
  pending: PendingMessage[];
  onSend: (text: string) => void;
  onClose: () => void;
  disabledReason: string | null;
}) {
  // The same query the timeline reads, so the panel adds no fetch.
  const { items } = useHistory(roomId);
  const byId = useMemo(() => rowsById(items), [items]);
  const root = byId.get(rootId) ?? null;
  const rows = useMemo(
    () => mergeRows(threadReplies(items, byId, rootId), pending.filter((message) => message.threadRootId === rootId)),
    [items, byId, rootId, pending],
  );
  const sender = getSender();
  return (
    <aside className="thread" aria-label="Thread">
      <header className="thread-head">
        <strong>Thread</strong>
        <button type="button" className="ghost" onClick={onClose}>Close</button>
      </header>
      <ul className="thread-rows">
        <li data-root="true">
          {root ? <span className="text">{root.envelope.body.text}</span> : <em>Original message not loaded</em>}
        </li>
        {rows.map((row) => (
          <RowView key={row.key} row={row} sender={sender} />
        ))}
      </ul>
      <Composer send={onSend} disabledReason={disabledReason} label="Reply in thread" />
    </aside>
  );
}
