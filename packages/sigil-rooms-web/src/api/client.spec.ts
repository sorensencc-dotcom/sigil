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

  it('lists the signed-in viewer contacts', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, {
      items: [{ contact_id: 'ct_1', kind: 'endpoint', login: 'ep_ada', display_name: 'Ada', created_at: '', updated_at: '', endpoint_ids: ['ep_ada'] }],
    }));
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await expect(client.listContacts()).resolves.toEqual([
      { contact_id: 'ct_1', kind: 'endpoint', login: 'ep_ada', display_name: 'Ada', created_at: '', updated_at: '', endpoint_ids: ['ep_ada'] },
    ]);
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://relay.test/v1/me/contacts');
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).method).toBe('GET');
  });

  it('creates, updates, and deletes contacts, including an empty 204 response', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const contact = { contact_id: 'ct/1', kind: 'endpoint', login: 'ep_ada', display_name: 'Ada', created_at: '', updated_at: '', endpoint_ids: ['ep_ada'] };
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return init.method === 'DELETE' ? new Response(null, { status: 204 }) : jsonResponse(200, { contact });
    });
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await expect(client.createContact('ep_ada', 'Ada')).resolves.toEqual(contact);
    await expect(client.updateContact('ct/1', 'Ada Lovelace')).resolves.toEqual(contact);
    await expect(client.deleteContact('ct/1')).resolves.toBeUndefined();
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([
      ['http://relay.test/v1/me/contacts', 'POST'],
      ['http://relay.test/v1/me/contacts/ct%2F1', 'PUT'],
      ['http://relay.test/v1/me/contacts/ct%2F1', 'DELETE'],
    ]);
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ login: 'ep_ada', display_name: 'Ada' });
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ display_name: 'Ada Lovelace' });
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

describe('api client: continueThread', () => {
  it('posts thread_root_id with a fresh idempotency key and returns the send result', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse(201, { code: 'OK', message_id: 'm9', room_seq: '9' });
    });
    const { client } = make(fetchImpl as unknown as typeof fetch);
    expect(await client.continueThread('room_1', 'msg_root')).toEqual({ code: 'OK', message_id: 'm9', room_seq: '9' });
    await client.continueThread('room_1', 'msg_root');
    expect(calls[0]![0]).toBe('http://relay.test/v1/rooms/room_1/continue');
    expect(calls[0]![1].method).toBe('POST');
    const first = JSON.parse(String(calls[0]![1].body)) as { thread_root_id: string; idempotency_key: string };
    const second = JSON.parse(String(calls[1]![1].body)) as { idempotency_key: string };
    expect(first.thread_root_id).toBe('msg_root');
    expect(first.idempotency_key).toMatch(/^continue-/);
    expect(second.idempotency_key).not.toBe(first.idempotency_key);
  });

  it('surfaces NOTHING_TO_CONTINUE as an ApiError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(409, { code: 'NOTHING_TO_CONTINUE', message: 'none' }));
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await expect(client.continueThread('room_1', 'msg_root')).rejects.toMatchObject({ code: 'NOTHING_TO_CONTINUE', status: 409 });
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

  it('includes mentions in the send body when provided and omits them when empty', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse(200, { code: 'OK', message_id: 'm', room_seq: '1' });
    });
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await client.sendMessage('room_1', '@ep_chief hi', 'key-m', undefined, ['ep_chief']);
    await client.sendMessage('room_1', 'plain', 'key-plain', undefined, []);
    await client.sendMessage('room_1', 'plain2', 'key-plain2');
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ text: '@ep_chief hi', idempotency_key: 'key-m', mentions: ['ep_chief'] });
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ text: 'plain', idempotency_key: 'key-plain' });
    expect(JSON.parse(String(calls[2]![1].body))).toEqual({ text: 'plain2', idempotency_key: 'key-plain2' });
  });
});
