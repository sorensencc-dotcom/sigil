import type { QueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../api/client';
import type { HistoryItem } from '../api/types';
import { maxSeq } from './seq';

export const HISTORY_PAGE_SIZE = 100;
export const HISTORY_WINDOW_MAX = 500;

export interface RoomHistoryWindow {
  items: HistoryItem[];
  hasOlder: boolean;
  hasNewer: boolean;
  atLatest: boolean;
}

export function historyKey(roomId: string) {
  return ['room', roomId, 'messages'] as const;
}

function unique(items: HistoryItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.message_id) && !!seen.add(item.message_id));
}

export async function fetchHistory(client: ApiClient, queryClient: QueryClient, roomId: string): Promise<RoomHistoryWindow> {
  const held = queryClient.getQueryData<RoomHistoryWindow>(historyKey(roomId));
  if (!held) {
    const page = await client.historyBefore(roomId, 'latest', HISTORY_PAGE_SIZE);
    return { items: page.items, hasOlder: page.has_older === true, hasNewer: false, atLatest: true };
  }

  // A room can change while the viewer is reading older history. Probe only one
  // bounded page and keep it out of the visible window until they jump to latest.
  const after = maxSeq(held.items.map((item) => item.room_seq));
  const page = await client.history(roomId, after, HISTORY_PAGE_SIZE);
  if (!held.atLatest) return { ...held, hasNewer: held.hasNewer || page.items.length > 0 || page.has_more === true };
  const items = unique([...held.items, ...page.items]);
  return {
    items: items.slice(-HISTORY_WINDOW_MAX),
    hasOlder: held.hasOlder,
    hasNewer: page.has_more === true,
    atLatest: page.has_more !== true,
  };
}

export async function loadOlderHistory(client: ApiClient, queryClient: QueryClient, roomId: string) {
  const held = queryClient.getQueryData<RoomHistoryWindow>(historyKey(roomId));
  const before = held?.items[0]?.room_seq;
  if (!held || before == null || !held.hasOlder) return held;
  const page = await client.historyBefore(roomId, String(before), HISTORY_PAGE_SIZE);
  const items = unique([...page.items, ...held.items]).slice(0, HISTORY_WINDOW_MAX);
  const next = { items, hasOlder: page.has_older === true, hasNewer: true, atLatest: false };
  queryClient.setQueryData(historyKey(roomId), next);
  return next;
}

export async function loadNewerHistory(client: ApiClient, queryClient: QueryClient, roomId: string) {
  const held = queryClient.getQueryData<RoomHistoryWindow>(historyKey(roomId));
  if (!held) return null;
  const after = maxSeq(held.items.map((item) => item.room_seq));
  const page = await client.history(roomId, after, HISTORY_PAGE_SIZE);
  const items = unique([...held.items, ...page.items]).slice(-HISTORY_WINDOW_MAX);
  const next = { items, hasOlder: held.hasOlder || items.length === HISTORY_WINDOW_MAX, hasNewer: page.has_more === true, atLatest: page.has_more !== true };
  queryClient.setQueryData(historyKey(roomId), next);
  return next;
}

export async function loadLatestHistory(client: ApiClient, queryClient: QueryClient, roomId: string) {
  const page = await client.historyBefore(roomId, 'latest', HISTORY_PAGE_SIZE);
  const next = { items: page.items, hasOlder: page.has_older === true, hasNewer: false, atLatest: true };
  queryClient.setQueryData(historyKey(roomId), next);
  return next;
}

export async function loadHistoryAround(client: ApiClient, queryClient: QueryClient, roomId: string, roomSeq: string) {
  const before = await client.historyBefore(roomId, (BigInt(roomSeq) + 1n).toString(), HISTORY_PAGE_SIZE / 2);
  const after = await client.history(roomId, roomSeq, HISTORY_PAGE_SIZE / 2);
  const items = unique([...before.items, ...after.items]).slice(-HISTORY_WINDOW_MAX);
  const next = {
    items,
    hasOlder: before.has_older === true,
    hasNewer: after.items.length > 0 || after.has_more === true,
    atLatest: after.items.length === 0 && after.has_more !== true,
  };
  queryClient.setQueryData(historyKey(roomId), next);
  return next;
}
