import { useMemo } from 'react';
import type { Member } from '../api/types';
import { useSelfEndpoint } from '../auth/AuthContext';
import { Composer } from './Composer';
import { mergeRows, type PendingMessage } from './mergeRows';
import { formatMentionText } from './resolveMentions';
import { RowView } from './RowView';
import { rowsById, threadReplies } from './threads';
import { useHistory } from './useHistory';
import type { LoginFor, NameFor } from './useContacts';

export function ThreadPanel({
  roomId,
  rootId,
  pending,
  onSend,
  onClose,
  disabledReason,
  nameFor,
  loginFor,
  members = [],
}: {
  roomId: string;
  rootId: string;
  pending: PendingMessage[];
  onSend: (text: string) => void;
  onClose: () => void;
  disabledReason: string | null;
  nameFor?: NameFor;
  loginFor?: LoginFor;
  members?: Member[];
}) {
  // The same query the timeline reads, so the panel adds no fetch.
  const { items } = useHistory(roomId);
  const byId = useMemo(() => rowsById(items), [items]);
  const root = byId.get(rootId) ?? null;
  const rows = useMemo(
    () => mergeRows(threadReplies(items, byId, rootId), pending.filter((message) => message.threadRootId === rootId)),
    [items, byId, rootId, pending],
  );
  const sender = useSelfEndpoint();
  return (
    <aside className="thread" aria-label="Thread">
      <header className="thread-head">
        <strong>Thread</strong>
        <button type="button" className="ghost" onClick={onClose}>Close</button>
      </header>
      <ul className="thread-rows">
        <li data-root="true">
          {root ? <span className="text">{formatMentionText(root.envelope.body.text, nameFor, members)}</span> : <em>Original message not loaded</em>}
        </li>
        {rows.map((row) => (
          <RowView key={row.key} row={row} sender={sender} nameFor={nameFor} loginFor={loginFor} members={members} />
        ))}
      </ul>
      <Composer send={onSend} disabledReason={disabledReason} label="Reply in thread" members={members} nameFor={nameFor} loginFor={loginFor} />
    </aside>
  );
}
