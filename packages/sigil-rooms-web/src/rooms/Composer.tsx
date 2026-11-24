import { useMemo, useRef, useState } from 'react';
import type { Member } from '../api/types';
import { useAuth, useSelfEndpoint } from '../auth/AuthContext';
import { previewRecipients, type RecipientPreview } from './recipientPreview';
import { roomMemberName } from './resolveMentions';
import type { LoginFor, NameFor } from './useContacts';

interface MentionRange {
  start: number;
  cursor: number;
  query: string;
}

function activeMention(value: string, cursor: number): MentionRange | null {
  const start = value.lastIndexOf('@', cursor - 1);
  if (start < 0 || value.slice(start + 1, cursor).includes('\n')) return null;
  return { start, cursor, query: value.slice(start + 1, cursor) };
}

export function Composer({
  send,
  disabledReason,
  label = 'Message',
  members = [],
  nameFor,
  loginFor,
}: {
  send: (text: string) => void;
  disabledReason: string | null;
  label?: string;
  members?: Member[];
  nameFor?: NameFor;
  loginFor?: LoginFor;
}) {
  const [text, setText] = useState('');
  const [mention, setMention] = useState<MentionRange | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const { session } = useAuth();
  const selfEndpoint = useSelfEndpoint();
  // The human whose authority the send runs under: the cookie session's, else the owner on this browser's member row.
  const subjectHumanId = session?.human_id ?? members.find((member) => member.endpoint_id === selfEndpoint)?.owner_id ?? null;
  const preview = useMemo(
    () => (text.trim() && members.some((member) => member.response_mode != null)
      ? previewRecipients(text, members, subjectHumanId, nameFor ?? ((id, fallback) => fallback || id), loginFor ?? (() => null))
      : null),
    [text, members, subjectHumanId, nameFor, loginFor],
  );
  const disabled = disabledReason !== null;
  const suggestions = mention && !disabled
    ? members.filter((member) => roomMemberName(member, members, nameFor, loginFor).toLowerCase().includes(mention.query.toLowerCase()))
    : [];
  function chooseMention(member: Member) {
    if (!mention) return;
    const name = roomMemberName(member, members, nameFor, loginFor);
    const insertion = `@${name} `;
    const next = `${text.slice(0, mention.start)}${insertion}${text.slice(mention.cursor)}`;
    const cursor = mention.start + insertion.length;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(cursor, cursor);
    });
  }
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = text.trim();
        if (!trimmed || disabled) return;
        send(trimmed);
        setText('');
        setMention(null);
      }}
    >
      {disabledReason ? <p className="reason">{disabledReason}</p> : null}
      <textarea
        ref={textarea}
        aria-label={label}
        aria-autocomplete="list"
        aria-controls={suggestions.length > 0 ? 'mention-options' : undefined}
        value={text}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
          setMention(activeMention(event.target.value, event.target.selectionStart));
        }}
      />
      {suggestions.length > 0 ? (
        <ul className="mention-picker" id="mention-options" role="listbox" aria-label="Room members">
          {suggestions.map((member) => {
            const name = roomMemberName(member, members, nameFor, loginFor);
            return (
              <li key={member.endpoint_id}>
                <button type="button" role="option" aria-label={`Mention ${name}`} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseMention(member)}>
                  {name}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {preview ? <RecipientPreviewView preview={preview} /> : null}
      <button type="submit" disabled={disabled}>Send</button>
    </form>
  );
}

function RecipientPreviewView({ preview }: { preview: RecipientPreview }) {
  const names = (items: { name: string }[]) => items.map((item) => item.name).join(', ');
  return (
    <div className="recipient-preview" role="group" aria-label="Recipient preview">
      {preview.willWake.length > 0 ? <p>Will wake: {names(preview.willWake)}</p> : null}
      {preview.routerPicksFrom ? <p>The router decides who answers. It may pick from {names(preview.routerPicksFrom)}.</p> : null}
      {preview.wakesNobody ? <p>No agent will be woken. Mention one with @ to wake it.</p> : null}
      {preview.wontWake.length > 0 ? (
        <p>Won&apos;t wake: {preview.wontWake.map((item) => `${item.name} (${item.reason})`).join('; ')}</p>
      ) : null}
    </div>
  );
}
