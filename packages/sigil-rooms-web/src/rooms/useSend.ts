import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import type { HistoryItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { getSender, setSender } from '../auth/tokenStore';
import { fetchHistory, historyKey } from './historyQuery';
import type { PendingMessage } from './mergeRows';

const NONE: PendingMessage[] = [];

// The relay answers these with no remedy a retry could supply.
function isRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.status === 400) return false;
  if (error.status === 403 && error.code === 'NO_SIGNING_KEY') return false;
  return true;
}

export function useSend(roomId: string) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  // Rows and errors are stored per room, so switching rooms never shows another room's rows.
  const [rowsByRoom, setRowsByRoom] = useState<Record<string, PendingMessage[]>>({});
  const [errorByRoom, setErrorByRoom] = useState<Record<string, unknown>>({});
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
    async (room: string, idempotencyKey: string, text: string) => {
      patch(room, idempotencyKey, { status: 'sending', error: undefined, retryable: undefined });
      let messageId: string;
      try {
        const result = await client.sendMessage(room, text, idempotencyKey);
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
        // fetchQuery refreshes the cache even when no timeline is mounted.
        const rows = await queryClient.fetchQuery<HistoryItem[]>({
          queryKey: historyKey(room),
          queryFn: () => fetchHistory(client, queryClient, room),
          staleTime: 0,
        });
        if (!getSender()) {
          const mine = rows.find((row) => row.message_id === messageId);
          if (mine) setSender(mine.envelope.sender.endpoint_id);
        }
      } catch {
        // The row keeps its messageId and drops out of the merge once a later refresh includes it.
      }
    },
    [client, patch, queryClient],
  );

  const send = useCallback(
    (text: string) => {
      const idempotencyKey = crypto.randomUUID();
      setErrorByRoom((all) => ({ ...all, [roomId]: null }));
      setRowsByRoom((all) => ({ ...all, [roomId]: [...(all[roomId] ?? []), { idempotencyKey, text, status: 'sending' }] }));
      void dispatch(roomId, idempotencyKey, text);
    },
    [dispatch, roomId],
  );

  const retry = useCallback(
    (idempotencyKey: string) => {
      const row = pendingRef.current.find((candidate) => candidate.idempotencyKey === idempotencyKey);
      if (row && row.status === 'failed') void dispatch(roomId, idempotencyKey, row.text);
    },
    [dispatch, roomId],
  );

  return { pending, send, retry, sendError };
}
