import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import type { Contact, HistoryItem, Member } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { getSender, setSender } from '../auth/tokenStore';
import { fetchHistory, historyKey } from './historyQuery';
import type { PendingMessage } from './mergeRows';
import { extractMentionTokens, normalizeMentions } from './resolveMentions';
import { contactsKey, createLoginFor, createNameFor } from './useContacts';
import { membersKey } from './useMembers';

const NONE: PendingMessage[] = [];

// The relay answers these with no remedy a retry could supply.
function isRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.status === 400) return false;
  if (error.status === 403 && error.code === 'NO_SIGNING_KEY') return false;
  if (error.code === 'ROOM_SEND_UNAVAILABLE') return false;
  return true;
}

async function loadMembers(
  queryClient: QueryClient,
  listMembers: (roomId: string) => Promise<Member[]>,
  roomId: string,
): Promise<Member[]> {
  const cached = queryClient.getQueryData<Member[]>(membersKey(roomId));
  if (cached) return cached;
  return queryClient.fetchQuery({
    queryKey: membersKey(roomId),
    queryFn: () => listMembers(roomId),
  });
}

async function loadContacts(
  queryClient: QueryClient,
  listContacts: () => Promise<Contact[]>,
): Promise<Contact[]> {
  const cached = queryClient.getQueryData<Contact[]>(contactsKey);
  if (cached) return cached;
  return queryClient.fetchQuery({ queryKey: contactsKey, queryFn: listContacts });
}

export function useSend(roomId: string) {
  const { client, mode } = useAuth();
  const queryClient = useQueryClient();
  // Rows and errors are stored per room, so switching rooms never shows another room's rows.
  const [rowsByRoom, setRowsByRoom] = useState<Record<string, PendingMessage[]>>({});
  const [errorByRoom, setErrorByRoom] = useState<Record<string, unknown>>({});
  // sessionStorage is not reactive: bump this so the caller re-renders once the sender is learned.
  const [, setSenderLearned] = useState(false);
  const pending = rowsByRoom[roomId] ?? NONE;
  const sendError = errorByRoom[roomId] ?? null;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const patch = useCallback((room: string, idempotencyKey: string, change: Partial<PendingMessage>) => {
    setRowsByRoom((all) => ({
      ...all,
      [room]: (all[room] ?? []).map((row) => (row.idempotencyKey === idempotencyKey ? { ...row, ...change } : row)),
    }));
  }, []);

  const dispatch = useCallback(
    async (room: string, idempotencyKey: string, text: string, threadRootId?: string) => {
      // Covers both send and retry: a stale error must not outlive a new attempt.
      setErrorByRoom((all) => (all[room] == null ? all : { ...all, [room]: null }));
      patch(room, idempotencyKey, { status: 'sending', error: undefined, retryable: undefined });
      let messageId: string;
      try {
        let mentions: string[] | undefined;
        let sentText = text;
        if (extractMentionTokens(text).length > 0) {
          try {
            const members = await loadMembers(queryClient, client.listMembers, room);
            let contacts: Contact[] = [];
            try {
              contacts = await loadContacts(queryClient, () => client.listContacts());
            } catch {
              // Contact names are optional; room display names and endpoint IDs still resolve.
            }
            const resolved = normalizeMentions(text, members, createNameFor(contacts), createLoginFor(contacts));
            sentText = resolved.text;
            mentions = resolved.mentions.length > 0 ? resolved.mentions : undefined;
          } catch {
            // Roster unavailable: still send the text; unresolved @tokens stay plain text.
            mentions = undefined;
          }
        }
        const result = await client.sendMessage(room, sentText, idempotencyKey, threadRootId, mentions);
        messageId = result.message_id;
        patch(room, idempotencyKey, { messageId });
      } catch (error) {
        setErrorByRoom((all) => ({ ...all, [room]: error }));
        patch(room, idempotencyKey, {
          status: 'failed',
          error: error instanceof ApiError ? error.message : 'send failed',
          retryable: isRetryable(error),
        });
        return;
      }
      // The relay accepted the message. A failed refresh must never mark it failed.
      try {
        // fetchQuery reuses an in-flight fetch for the same key; cancel it so one that started before this send committed cannot answer.
        await queryClient.cancelQueries({ queryKey: historyKey(room) });
        // fetchQuery refreshes the cache even when no timeline is mounted.
        const rows = await queryClient.fetchQuery<HistoryItem[]>({
          queryKey: historyKey(room),
          queryFn: () => fetchHistory(client, queryClient, room),
          staleTime: 0,
        });
        if (mode !== 'cookie' && !getSender()) {
          const mine = rows.find((row) => row.message_id === messageId);
          if (mine) {
            setSender(mine.envelope.sender.endpoint_id);
            setSenderLearned(true);
          }
        }
      } catch {
        // The row keeps its messageId and drops out of the merge once a later refresh includes it.
      }
    },
    [client, mode, patch, queryClient],
  );

  const send = useCallback(
    (text: string, threadRootId?: string) => {
      const idempotencyKey = crypto.randomUUID();
      setErrorByRoom((all) => ({ ...all, [roomId]: null }));
      setRowsByRoom((all) => ({
        ...all,
        [roomId]: [...(all[roomId] ?? []), { idempotencyKey, text, status: 'sending', ...(threadRootId ? { threadRootId } : {}) }],
      }));
      void dispatch(roomId, idempotencyKey, text, threadRootId);
    },
    [dispatch, roomId],
  );

  const retry = useCallback(
    (idempotencyKey: string) => {
      const row = pendingRef.current.find((candidate) => candidate.idempotencyKey === idempotencyKey);
      if (row && row.status === 'failed') void dispatch(roomId, idempotencyKey, row.text, row.threadRootId);
    },
    [dispatch, roomId],
  );

  return { pending, send, retry, sendError };
}
