import { useRef, useState } from 'react';
import type { Member } from '../api/types';
import { previewRecipients, type AgentPreview, type RecipientPreview, type WontWakeReason } from './recipientPreview';
import { normalizeMentions, roomMemberName } from './resolveMentions';
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

const WONT_WAKE: Record<WontWakeReason, string> = {
  not_mentioned: 'not mentioned',
  report_only: 'posts reports only',
  not_allowed: 'only its owner can wake it',
  no_router: 'no router picks for you',
};

function Recipients({ preview, name }: { preview: RecipientPreview; name: (endpointId: string) => string }) {
  const list = (status: AgentPreview['status']) => preview.agents.filter((agent) => agent.status === status).map((agent) => name(agent.endpointId));
  const wakes = list('wakes');
  const unknown = list('unknown');
  const candidates = list('router_candidate');
  const wontWake = preview.agents.flatMap((agent) => (agent.status === 'wont_wake' ? [`${name(agent.endpointId)} (${WONT_WAKE[agent.reason]})`] : []));
  return (
    <div className="recipients" aria-label="Who this message wakes">
      {preview.mode === 'router' ? (
        // A prediction: the router reads the message and picks, or picks no one.
        <>
          {candidates.length > 0 ? <p>The router decides. It may wake {candidates.join(', ')}.</p> : null}
          {unknown.length > 0 ? <p>The router may also consider these agents if you own them: {unknown.join(', ')}.</p> : null}
        </>
      ) : (
        <>
          {wakes.length > 0 ? <p>Will wake: {wakes.join(', ')}</p> : null}
          {unknown.length > 0 ? <p>Wakes only if you own it: {unknown.join(', ')}</p> : null}
          {wakes.length === 0 && unknown.length === 0 ? <p>Wakes no agent.</p> : null}
        </>
      )}
      {wontWake.length > 0 ? <p>Won't wake: {wontWake.join(', ')}</p> : null}
    </div>
  );
}

export function Composer({
  send,
  disabledReason,
  label = 'Message',
  members = [],
  nameFor,
  loginFor,
  viewer = null,
}: {
  send: (text: string) => void;
  disabledReason: string | null;
  label?: string;
  members?: Member[];
  nameFor?: NameFor;
  loginFor?: LoginFor;
  /** This browser's endpoint ID, so owner-only agents can be judged. */
  viewer?: string | null;
}) {
  const [text, setText] = useState('');
  const [mention, setMention] = useState<MentionRange | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const disabled = disabledReason !== null;
  // The same resolution useSend applies, so the preview and the sent mentions agree.
  const preview = disabled || !text.trim() ? null : previewRecipients(normalizeMentions(text, members, nameFor, loginFor).mentions, members, viewer);
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
      <button type="submit" disabled={disabled}>Send</button>
      {preview ? (
        <Recipients
          preview={preview}
          // An empty display name makes roomMemberName read the member row's.
          name={(endpointId) => roomMemberName({ endpoint_id: endpointId, display_name: '' }, members, nameFor, loginFor)}
        />
      ) : null}
    </form>
  );
}
