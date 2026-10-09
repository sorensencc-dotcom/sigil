import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../errors/ErrorBanner';
import { membersKey } from './useMembers';

export function RenameTitle({ roomId, name, canRename, onGone }: { roomId: string; name: string; canRename: boolean; onGone: () => void }) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [tooLong, setTooLong] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
    else if (wasEditing.current) renameButtonRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const rename = useMutation({
    mutationFn: (next: string) => client.renameRoom(roomId, next),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['rooms'] });
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.code === 'ROOM_NOT_FOUND') onGone();
      // The caller's role changed under the client: refetch the roster so the control disappears.
      if (error.code === 'ROUTE_NOT_AUTHORIZED') void queryClient.invalidateQueries({ queryKey: membersKey(roomId) });
    },
  });

  if (!editing) {
    return (
      <h2 className="room-title">
        {name}
        {canRename ? (
          <button
            ref={renameButtonRef}
            type="button"
            className="ghost"
            aria-label="Rename room"
            onClick={() => { setDraft(name); setTooLong(false); rename.reset(); setEditing(true); }}
          >
            ✎
          </button>
        ) : null}
      </h2>
    );
  }
  return (
    <form
      className="rename"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = draft.trim();
        if (!trimmed || rename.isPending) return;
        if (trimmed.length > 80) { setTooLong(true); return; }
        setTooLong(false);
        if (trimmed === name) { setEditing(false); return; }
        rename.mutate(trimmed);
      }}
    >
      <input
        ref={inputRef}
        aria-label="Room name"
        value={draft}
        maxLength={80}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') setEditing(false); }}
      />
      <button type="submit" disabled={rename.isPending || !draft.trim()}>Save</button>
      <button type="button" className="ghost" onClick={() => setEditing(false)}>Cancel</button>
      {tooLong ? <p role="alert">Room names are 1-80 characters</p> : null}
      <ErrorBanner error={rename.error} />
    </form>
  );
}
