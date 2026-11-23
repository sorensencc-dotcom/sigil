import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createClient } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function make(fetchImpl: typeof fetch, onUnauthorized = vi.fn()) {
  return { client: createClient({ mode: 'cookie', baseUrl: '', onUnauthorized, fetchImpl }), onUnauthorized };
}

describe('api client in cookie mode', () => {
  afterEach(() => vi.useRealTimers());

  it('sends same-origin credentials with a relative URL and no Authorization on GET', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, { items: [] }));
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await client.listRooms();
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/v1/rooms');
    expect(init.credentials).toBe('same-origin');
    const keys = Object.keys(init.headers as Record<string, string>).map((k) => k.toLowerCase());
    expect(keys).not.toContain('authorization');
    expect(keys).not.toContain('x-sigil-csrf');
  });

  it('adds X-Sigil-CSRF: 1 on POST only and never an Authorization header', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, { room: { conversation_id: 'r', name: 'n' } }));
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await client.createRoom('n', 'purpose');
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Sigil-CSRF']).toBe('1');
    expect(init.credentials).toBe('same-origin');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'n', description: 'purpose' });
  });

  it('omits description when creating a room without a purpose', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, { room: { conversation_id: 'r', name: 'n' } }));
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await client.createRoom('n');
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual({ name: 'n' });
  });

  it('calls onUnauthorized on a 401 and works without any token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { code: 'UNAUTHENTICATED', message: 'no' }));
    const { client, onUnauthorized } = make(fetchImpl as unknown as typeof fetch);
    await expect(client.listRooms()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('me() reads /v1/auth/me and logout() posts /v1/auth/logout', async () => {
    const session = { human_id: 'h', endpoint_id: 'ep', display_name: 'Ada', is_operator: false };
    const fetchImpl = vi.fn(async (url: string) => jsonResponse(200, url.endsWith('/me') ? session : {}));
    const { client } = make(fetchImpl as unknown as typeof fetch);
    expect(await client.me()).toEqual(session);
    await client.logout();
    const [url, init] = fetchImpl.mock.calls[1]! as unknown as [string, RequestInit];
    expect(url).toBe('/v1/auth/logout');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Sigil-CSRF']).toBe('1');
  });

  it('lists contacts with same-origin credentials', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, { items: [] }));
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await client.listContacts();
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/v1/me/contacts');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('same-origin');
  });

  it('lists room invocations from the room-scoped endpoint', async () => {
    const queued = [{ invocation_id: 'i_old', endpoint_id: 'ep_agent', status: 'queued', subject_human_id: 'h1' }];
    const running = [{ invocation_id: 'i_running', endpoint_id: 'ep_other', status: 'running', subject_human_id: 'h2' }];
    const fetchImpl = vi.fn(async (url: string) => {
      const status = new URL(url, 'http://sigil.test').searchParams.get('status');
      return jsonResponse(200, { items: status === 'queued' ? queued : running });
    });
    const { client } = make(fetchImpl as unknown as typeof fetch);
    expect(await client.listInvocations('room/1')).toEqual([...queued, ...running]);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      '/v1/rooms/room%2F1/invocations?status=queued&limit=500',
      '/v1/rooms/room%2F1/invocations?status=running&limit=500',
    ]);
  });

  it('aborts the other invocation request when one active-status read fails', async () => {
    const abortSibling = vi.fn();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const status = new URL(url, 'http://sigil.test').searchParams.get('status');
      if (status === 'queued') throw new Error('offline');
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          abortSibling();
          reject(new Error('aborted'));
        }, { once: true });
      });
    });
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await expect(client.listInvocations('room/1')).rejects.toMatchObject({ code: 'NETWORK' });
    expect(abortSibling).toHaveBeenCalledOnce();
  });

  it('aborts invocation reads after ten seconds, including a stalled response body', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => new Promise<string>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    } as Response));
    const { client } = make(fetchImpl as unknown as typeof fetch);
    let settled = false;
    const pending = client.listInvocations('room/1').then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
