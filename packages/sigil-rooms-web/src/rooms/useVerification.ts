import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import type { HistoryItem } from '../api/types';
import { getPin, setPin } from '../verify/pins';
import { verifyRow, type RelayKey, type VerifyResult } from '../verify/verifyRow';

export interface Verification {
  result: VerifyResult | null; // null while checking
  pinned: boolean;
  relayKey: RelayKey | null; // the relay-served key that signed this row, if any
  pin: () => void;
  unpin: () => void;
}

export function useVerification(roomId: string, item: HistoryItem): Verification {
  const { client } = useAuth();
  const endpointId = item.envelope.sender.endpoint_id;
  const [pinVersion, setPinVersion] = useState(0);
  const pinned = useMemo(() => getPin(endpointId), [endpointId, pinVersion]);
  const keys = useQuery({ queryKey: ['room', roomId, 'keys', endpointId], queryFn: () => client.roomKeys(roomId, endpointId), staleTime: 60_000, retry: false });
  const settled = !keys.isPending || pinned !== null;
  const result = useQuery({
    queryKey: ['verify', item.message_id, item.canonical_bytes, item.envelope.signature?.value, keys.data, pinned?.public_key ?? null],
    queryFn: () => verifyRow(item, keys.data ?? null, pinned),
    enabled: settled,
    staleTime: Infinity,
  });
  const relayKey = keys.data?.find((key) => key.key_id === item.envelope.signature?.key_id && key.algorithm === 'Ed25519') ?? null;
  const pin = useCallback(() => {
    if (relayKey) setPin(endpointId, { key_id: relayKey.key_id, public_key: relayKey.public_key });
    setPinVersion((v) => v + 1);
  }, [endpointId, relayKey]);
  const unpin = useCallback(() => { setPin(endpointId, null); setPinVersion((v) => v + 1); }, [endpointId]);
  return { result: settled ? (result.data ?? null) : null, pinned: pinned !== null, relayKey, pin, unpin };
}
