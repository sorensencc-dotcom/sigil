import type { AckResult, Session, HistoryPage, InvokableBy, Member, ResponseMode, Room, SendResult, StopResult, TicketResult } from './types';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;
  constructor(code: string, status: number, message: string, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export interface ClientOptions {
  /** 'cookie' sends the session cookie (same-origin, relative URLs, CSRF header) and never a bearer token. */
  mode?: 'token' | 'cookie';
  baseUrl: string;
  getToken?: () => string | null;
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
}

export interface ApiClient {
  listRooms(): Promise<Room[]>;
  createRoom(name: string): Promise<Room>;
  history(roomId: string, afterSeq: string, limit?: number): Promise<HistoryPage>;
  sendMessage(roomId: string, text: string, idempotencyKey: string, threadRootId?: string): Promise<SendResult>;
  continueThread(roomId: string, threadRootId: string): Promise<SendResult>;
  listMembers(roomId: string): Promise<Member[]>;
  renameRoom(roomId: string, name: string): Promise<Room>;
  setResponseMode(roomId: string, endpointId: string, mode: ResponseMode): Promise<Member>;
  setInvokableBy(roomId: string, endpointId: string, mode: InvokableBy): Promise<Member>;
  stopRoom(roomId: string): Promise<StopResult>;
  ack(roomId: string, upToRoomSeq: string): Promise<AckResult>;
  wsTicket(): Promise<TicketResult>;
  me(): Promise<Session>;
  logout(): Promise<void>;
}

export function createClient({ mode = 'token', baseUrl, getToken, onUnauthorized, fetchImpl = (...args) => fetch(...args) }: ClientOptions): ApiClient {
  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      if (mode === 'cookie') {
        // The session cookie is HttpOnly and travels on its own; the CSRF header is required on every non-GET.
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (method !== 'GET') headers['X-Sigil-CSRF'] = '1';
        response = await fetchImpl(path, {
          method,
          credentials: 'same-origin',
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } else {
        const token = getToken?.() ?? null;
        if (!token) throw new ApiError('UNAUTHENTICATED', 401, 'No token');
        // Only authorization and content-type: the relay's CORS allows exactly those.
        response = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('NETWORK', 0, mode === 'cookie' ? "Can't reach the server." : `Can't reach relay at ${baseUrl}. Check --browser-origin.`);
    }
    const text = await response.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) {
      if (response.status === 401) onUnauthorized?.();
      throw new ApiError(parsed?.code ?? `HTTP_${response.status}`, response.status, parsed?.message ?? response.statusText, parsed?.request_id);
    }
    return parsed as T;
  }

  return {
    async listRooms() {
      return (await request<{ items: Room[] }>('GET', '/v1/rooms')).items;
    },
    async createRoom(name) {
      return (await request<{ room: Room }>('POST', '/v1/rooms', { name })).room;
    },
    history(roomId, afterSeq, limit = 100) {
      return request<HistoryPage>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/messages?after_seq=${encodeURIComponent(afterSeq)}&limit=${limit}`);
    },
    sendMessage(roomId, text, idempotencyKey, threadRootId) {
      return request<SendResult>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/messages`, {
        text,
        idempotency_key: idempotencyKey,
        ...(threadRootId ? { thread_root_id: threadRootId } : {}),
      });
    },
    continueThread(roomId, threadRootId) {
      // A fresh key per click: a double click posts twice, which the relay answers with 409 once the budget refilled.
      return request<SendResult>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/continue`, {
        thread_root_id: threadRootId,
        idempotency_key: `continue-${globalThis.crypto.randomUUID()}`,
      });
    },
    async listMembers(roomId) {
      return (await request<{ items: Member[] }>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/members`)).items;
    },
    async renameRoom(roomId, name) {
      return (await request<{ room: Room }>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/rename`, { name })).room;
    },
    async setResponseMode(roomId, endpointId, mode) {
      return (await request<{ member: Member }>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(endpointId)}/response-mode`, { response_mode: mode })).member;
    },
    async setInvokableBy(roomId, endpointId, mode) {
      return (await request<{ member: Member }>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(endpointId)}/invokable-by`, { invokable_by: mode })).member;
    },
    async stopRoom(roomId) {
      const { code, cancelled } = await request<StopResult>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/stop`);
      return { code, cancelled };
    },
    ack(roomId, upToRoomSeq) {
      return request<AckResult>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/ack`, { up_to_room_seq: upToRoomSeq });
    },
    wsTicket() {
      return request<TicketResult>('POST', '/v1/rooms/ws-ticket');
    },
    me() {
      return request<Session>('GET', '/v1/auth/me');
    },
    async logout() {
      await request<unknown>('POST', '/v1/auth/logout');
    },
  };
}
