import type { AckResult, HistoryPage, Room, SendResult, TicketResult } from './types';

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
  history(roomId: string, afterSeq: string, limit?: number): Promise<HistoryPage>;
  sendMessage(roomId: string, text: string, idempotencyKey: string): Promise<SendResult>;
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
    history(roomId, afterSeq, limit = 100) {
      return request<HistoryPage>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/messages?after_seq=${encodeURIComponent(afterSeq)}&limit=${limit}`);
    },
    sendMessage(roomId, text, idempotencyKey) {
      return request<SendResult>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/messages`, { text, idempotency_key: idempotencyKey });
    },
    ack(roomId, upToRoomSeq) {
      return request<AckResult>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/ack`, { up_to_room_seq: upToRoomSeq });
    },
    wsTicket() {
      return request<TicketResult>('POST', '/v1/rooms/ws-ticket');
    },
  };
}
