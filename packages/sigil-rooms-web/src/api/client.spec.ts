import { describe, expect, it, vi } from 'vitest';
import { ApiError, createClient } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function make(fetchImpl: typeof fetch, token: string | null = 'tok', onUnauthorized = vi.fn()) {
  return { client: createClient({ baseUrl: 'http://relay.test', getToken: () => token, onUnauthorized, fetchImpl }), onUnauthorized };
}

describe('api client', () => {
  it('sends only authorization and content-type headers', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, { code: 'OK', items: [] }));
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await client.listRooms();
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual(['authorization', 'content-type']);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('maps an error body to ApiError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { request_id: 'r1', code: 'ROOM_NOT_FOUND', message: 'Room not found' }));
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await expect(client.history('room_x', '0')).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND', status: 404, requestId: 'r1' });
  });

  it('calls onUnauthorized on any 401', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { request_id: 'r2', code: 'ANYTHING', message: 'no' }));
    const { client, onUnauthorized } = make(fetchImpl as unknown as typeof fetch);
    await expect(client.listRooms()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('maps a fetch failure to NETWORK', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await expect(client.listRooms()).rejects.toMatchObject({ code: 'NETWORK', status: 0 });
  });

  it('rejects without a token and does not call fetch', async () => {
    const fetchImpl = vi.fn();
    const { client } = make(fetchImpl as unknown as typeof fetch, null);
    await expect(client.listRooms()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('builds the history, send, ack, and ticket requests', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse(200, { code: 'OK', items: [], next_after_seq: '0', message_id: 'm', room_seq: '1', acknowledged: 0, ticket: 't', expires_at: 'e' });
    });
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await client.history('room_1', '7', 100);
    await client.sendMessage('room_1', 'hi', 'key-1');
    await client.ack('room_1', '9');
    await client.wsTicket();
    expect(calls[0]![0]).toBe('http://relay.test/v1/rooms/room_1/messages?after_seq=7&limit=100');
    expect(calls[1]![0]).toBe('http://relay.test/v1/rooms/room_1/messages');
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ text: 'hi', idempotency_key: 'key-1' });
    expect(JSON.parse(calls[2]![1].body as string)).toEqual({ up_to_room_seq: '9' });
    expect(calls[3]![0]).toBe('http://relay.test/v1/rooms/ws-ticket');
    expect(calls[3]![1].method).toBe('POST');
  });
});

describe('api client: room management', () => {
  it('builds the members, rename, response-mode, stop, and threaded send requests', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse(200, { code: 'OK', items: [], room: { conversation_id: 'room_1' }, member: { endpoint_id: 'ep_claude' }, cancelled: 2, message_id: 'm', room_seq: '1' });
    });
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await client.listMembers('room_1');
    await client.renameRoom('room_1', 'new name');
    await client.setResponseMode('room_1', 'ep_claude', 'mentions_only');
    expect(await client.stopRoom('room_1')).toEqual({ code: 'OK', cancelled: 2 });
    await client.sendMessage('room_1', 'hi', 'key-1', 'msg_root');
    await client.sendMessage('room_1', 'top', 'key-2');
    expect(calls[0]![0]).toBe('http://relay.test/v1/rooms/room_1/members');
    expect(calls[0]![1].method).toBe('GET');
    expect(calls[1]![0]).toBe('http://relay.test/v1/rooms/room_1/rename');
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ name: 'new name' });
    expect(calls[2]![0]).toBe('http://relay.test/v1/rooms/room_1/members/ep_claude/response-mode');
    expect(JSON.parse(String(calls[2]![1].body))).toEqual({ response_mode: 'mentions_only' });
    expect(calls[3]![0]).toBe('http://relay.test/v1/rooms/room_1/stop');
    expect(JSON.parse(String(calls[4]![1].body))).toEqual({ text: 'hi', idempotency_key: 'key-1', thread_root_id: 'msg_root' });
    expect(JSON.parse(String(calls[5]![1].body))).toEqual({ text: 'top', idempotency_key: 'key-2' });
  });
});
