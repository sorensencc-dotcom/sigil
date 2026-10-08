import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';
import { toSeq } from './seq';

export function useAck(roomId: string, debounceMs = 500): (seq: string) => void {
  const { client } = useAuth();
  const wanted = useRef<bigint>(0n);
  const acked = useRef<bigint>(0n);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    if (document.visibilityState !== 'visible') return;
    if (wanted.current <= acked.current) return;
    const upTo = wanted.current;
    acked.current = upTo;
    client.ack(roomId, upTo.toString()).catch((error: unknown) => {
      console.warn('ack failed; the next fetch repeats it', error);
      if (acked.current === upTo) acked.current = 0n;
    });
  }, [client, roomId]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, debounceMs);
  }, [debounceMs, flush]);

  useEffect(() => {
    wanted.current = 0n;
    acked.current = 0n;
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
