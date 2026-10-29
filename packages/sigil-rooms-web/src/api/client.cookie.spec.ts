import { describe, expect, it, vi } from 'vitest';
import { ApiError, createClient } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function make(fetchImpl: typeof fetch, onUnauthorized = vi.fn()) {
  return { client: createClient({ mode: 'cookie', baseUrl: '', onUnauthorized, fetchImpl }), onUnauthorized };
}

describe('api client in cookie mode', () => {
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
    await client.createRoom('n');
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Sigil-CSRF']).toBe('1');
    expect(init.credentials).toBe('same-origin');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
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
});
