import type { AckResult, HistoryPage, Member, ResponseMode, Room, SendResult, StopResult, TicketResult } from './types';

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
  baseUrl: string;
  getToken: () => string | null;
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
}

export interface ApiClient {
  listRooms(): Promise<Room[]>;
  createRoom(name: string): Promise<Room>;
  history(roomId: string, afterSeq: string, limit?: number): Promise<HistoryPage>;
  sendMessage(roomId: string, text: string, idempotencyKey: string, threadRootId?: string): Promise<SendResult>;
  listMembers(roomId: string): Promise<Member[]>;
  renameRoom(roomId: string, name: string): Promise<Room>;
  setResponseMode(roomId: string, endpointId: string, mode: ResponseMode): Promise<Member>;
  stopRoom(roomId: string): Promise<StopResult>;
  ack(roomId: string, upToRoomSeq: string): Promise<AckResult>;
  wsTicket(): Promise<TicketResult>;
}

export function createClient({ baseUrl, getToken, onUnauthorized, fetchImpl = (...args) => fetch(...args) }: ClientOptions): ApiClient {
  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const token = getToken();
    if (!token) throw new ApiError('UNAUTHENTICATED', 401, 'No token');
    let response: Response;
    try {
      // Only authorization and content-type: the relay's CORS allows exactly those.
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError('NETWORK', 0, `Can't reach relay at ${baseUrl}. Check --browser-origin.`);
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
    async listMembers(roomId) {
      return (await request<{ items: Member[] }>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/members`)).items;
    },
    async renameRoom(roomId, name) {
      return (await request<{ room: Room }>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/rename`, { name })).room;
    },
    async setResponseMode(roomId, endpointId, mode) {
      return (await request<{ member: Member }>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(endpointId)}/response-mode`, { response_mode: mode })).member;
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
  };
}
