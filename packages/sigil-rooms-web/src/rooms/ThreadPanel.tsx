import { useMemo } from 'react';
import type { Member } from '../api/types';
import { useSelfEndpoint } from '../auth/AuthContext';
import { Composer } from './Composer';
import { mergeRows, type PendingMessage } from './mergeRows';
import { formatMentionText } from './resolveMentions';
import { RowView } from './RowView';
import { SenderChip, senderName } from './SenderChip';
import { rowsById, threadReplies } from './threads';
import { useHistory } from './useHistory';
import type { LoginFor, NameFor, OwnerNameFor } from './useContacts';

export function ThreadPanel({
  roomId,
  rootId,
  pending,
  onSend,
  onClose,
  disabledReason,
  nameFor,
  loginFor,
  ownerNameFor,
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
  ownerNameFor?: OwnerNameFor;
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
          {root ? (
            <>
              <div className="meta">
                <SenderChip
                  endpointId={root.envelope.sender.endpoint_id}
                  ownerId={root.envelope.sender.owner_id}
                  name={senderName(root.envelope.sender.endpoint_id, root.display_name, members, nameFor, loginFor)}
                  members={members}
                  viewer={sender}
                  ownerNameFor={ownerNameFor}
                  nameFor={nameFor}
                  loginFor={loginFor}
                />
              </div>
              <span className="text">{formatMentionText(root.envelope.body.text, nameFor, members)}</span>
            </>
          ) : <em>Original message not loaded</em>}
        </li>
        {rows.map((row) => (
          <RowView key={row.key} row={row} roomId={roomId} sender={sender} nameFor={nameFor} loginFor={loginFor} ownerNameFor={ownerNameFor} members={members} />
        ))}
      </ul>
      <Composer send={onSend} disabledReason={disabledReason} label="Reply in thread" members={members} nameFor={nameFor} loginFor={loginFor} viewer={sender} />
    </aside>
  );
}
