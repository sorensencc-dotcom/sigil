import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';
import { toSeq } from './seq';

export function useAck(roomId: string, debounceMs = 500): (seq: string) => void {
  const { client } = useAuth();
  const wanted = useRef<bigint>(0n);
  const acked = useRef<bigint>(0n);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentRoom = useRef(roomId);

  const flush = useCallback(() => {
    timer.current = null;
    if (document.visibilityState !== 'visible') return;
    if (wanted.current <= acked.current) return;
    const upTo = wanted.current;
    acked.current = upTo;
    client.ack(roomId, upTo.toString()).catch((error: unknown) => {
      console.warn('ack failed; the next reported seq retries it', error);
      if (currentRoom.current === roomId && acked.current === upTo) acked.current = 0n;
    });
  }, [client, roomId]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, debounceMs);
  }, [debounceMs, flush]);

  useEffect(() => {
    // Child effects (Timeline) may already have reported a seq before this runs, so
    // reset only when the room actually changed.
    if (currentRoom.current !== roomId) {
      currentRoom.current = roomId;
      wanted.current = 0n;
      acked.current = 0n;
    }
    // A StrictMode remount cleanup clears the timer; re-arm if a seq is pending.
    if (wanted.current > acked.current) schedule();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && wanted.current > acked.current) schedule();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [roomId, schedule]);

  return useCallback(
    (seq: string) => {
      const next = toSeq(seq);
      if (next > wanted.current) wanted.current = next;
      if (wanted.current > acked.current) schedule();
    },
    [schedule],
  );
}
