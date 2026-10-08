import type { QueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../api/client';
import type { HistoryItem } from '../api/types';
import { maxSeq } from './seq';

const PAGE = 100;

export function historyKey(roomId: string) {
  return ['room', roomId, 'messages'] as const;
}

export async function fetchHistory(client: ApiClient, queryClient: QueryClient, roomId: string): Promise<HistoryItem[]> {
  // Read after the highest row already cached, so only new rows cross the wire.
  const held = queryClient.getQueryData<HistoryItem[]>(historyKey(roomId)) ?? [];
  const collected = [...held];
  let after = maxSeq(held.map((item) => item.room_seq));
  for (;;) {
    const page = await client.history(roomId, after, PAGE);
    collected.push(...page.items);
    if (page.items.length < PAGE) break;
    after = maxSeq(page.items.map((item) => item.room_seq));
  }
  return collected;
}
