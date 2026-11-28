import type { RelayKey } from '../verify/verifyRow';
import type { AckResult, AgentRoomInvite, Contact, CreatedAgentRoomInvite, CreatedRoomInvite, GrantableRole, JoinRequest, JoinRequestQueue, OwnJoinRequest, RoomInvite, Session, HistoryPage, Invocation, InvokableBy, Member, MentionPage, ResponseMode, Room, RoomSearchPage, SendResult, StopResult, TicketResult } from './types';

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

// One pending hold on a room envelope (#269). The held body is never sent. challenge_id and
// approval_url are null for everyone but the approving human. The other fields are optional so a
// client still renders against a relay that predates them.
export interface RoomApproval {
  approver_name: string;
  approval_url: string | null;
  challenge_id?: string | null;
  message_id?: string;
  sender_endpoint_id?: string;
  sender_name?: string;
  capabilities?: string[];
  created_at?: string | null;
  expires_at?: string | null;
}

export interface ApiClient {
  listRooms(): Promise<Room[]>;
  createRoom(name: string, description?: string): Promise<Room>;
  history(roomId: string, afterSeq: string, limit?: number): Promise<HistoryPage>;
  historyBefore(roomId: string, beforeSeq: string | 'latest', limit?: number): Promise<HistoryPage>;
  searchHistory(roomId: string, query: string, beforeSeq?: string | null, limit?: number): Promise<RoomSearchPage>;
  sendMessage(roomId: string, text: string, idempotencyKey: string, threadRootId?: string, mentions?: string[]): Promise<SendResult>;
  continueThread(roomId: string, threadRootId: string): Promise<SendResult>;
  listMembers(roomId: string): Promise<Member[]>;
  listApprovals(roomId: string): Promise<RoomApproval[]>;
  listAgentRoomInvites(roomId: string): Promise<AgentRoomInvite[]>;
  createAgentRoomInvite(roomId: string, endpointId: string): Promise<CreatedAgentRoomInvite>;
  revokeAgentRoomInvite(roomId: string, inviteId: string): Promise<void>;
  // Human invites and the join request queue (#272). Optional so older test doubles still type-check.
  listRoomInvites?(roomId: string): Promise<RoomInvite[]>;
  createRoomInvite?(roomId: string, name: string, role: GrantableRole): Promise<CreatedRoomInvite>;
  revokeRoomInvite?(roomId: string, inviteId: string): Promise<void>;
  listJoinRequests?(roomId: string): Promise<JoinRequestQueue>;
  decideJoinRequest?(roomId: string, requestId: string, decision: 'accept' | 'decline', role?: GrantableRole): Promise<JoinRequest>;
  listOwnJoinRequests?(): Promise<OwnJoinRequest[]>;
  withdrawJoinRequest?(requestId: string): Promise<void>;
  listInvocations(roomId: string): Promise<Invocation[]>;
  renameRoom(roomId: string, name: string): Promise<Room>;
  setResponseMode(roomId: string, endpointId: string, mode: ResponseMode): Promise<Member>;
  setInvokableBy(roomId: string, endpointId: string, mode: InvokableBy): Promise<Member>;
  stopRoom(roomId: string): Promise<StopResult>;
  ack(roomId: string, upToRoomSeq: string): Promise<AckResult>;
  listMentions(cursor?: string): Promise<MentionPage>;
  roomKeys(roomId: string, endpointId: string): Promise<RelayKey[]>;
  wsTicket(): Promise<TicketResult>;
  me(): Promise<Session>;
  listContacts(): Promise<Contact[]>;
  createContact(login: string, displayName: string): Promise<Contact>;
  updateContact(contactId: string, displayName: string): Promise<Contact>;
  deleteContact(contactId: string): Promise<void>;
  logout(): Promise<void>;
}

export function createClient({ mode = 'token', baseUrl, getToken, onUnauthorized, fetchImpl = (...args) => fetch(...args) }: ClientOptions): ApiClient {
  async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    let text: string;
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
          signal,
        });
      } else {
        const token = getToken?.() ?? null;
        if (!token) throw new ApiError('UNAUTHENTICATED', 401, 'No token');
        // Only authorization and content-type: the relay's CORS allows exactly those.
        response = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
      }
      text = await response.text();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('NETWORK', 0, mode === 'cookie' ? "Can't reach the server." : `Can't reach relay at ${baseUrl}. Check --browser-origin.`);
    }
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
    async listApprovals(roomId) {
      return (await request<{ items: RoomApproval[] }>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/approvals`)).items;
    },
    async createRoom(name, description) {
      return (await request<{ room: Room }>('POST', '/v1/rooms', { name, ...(description !== undefined ? { description } : {}) })).room;
    },
    history(roomId, afterSeq, limit = 100) {
      return request<HistoryPage>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/messages?after_seq=${encodeURIComponent(afterSeq)}&limit=${limit}`);
    },
    historyBefore(roomId, beforeSeq, limit = 100) {
      return request<HistoryPage>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/messages?before_seq=${encodeURIComponent(beforeSeq)}&limit=${limit}`);
    },
    searchHistory(roomId, query, beforeSeq = null, limit = 20) {
      const cursor = beforeSeq == null ? '' : `&before_seq=${encodeURIComponent(beforeSeq)}`;
      return request<RoomSearchPage>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/messages/search?q=${encodeURIComponent(query)}${cursor}&limit=${limit}`);
    },
    sendMessage(roomId, text, idempotencyKey, threadRootId, mentions) {
      return request<SendResult>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/messages`, {
        text,
        idempotency_key: idempotencyKey,
        ...(threadRootId ? { thread_root_id: threadRootId } : {}),
        ...(mentions && mentions.length > 0 ? { mentions } : {}),
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
      return (await request<{ items?: Member[] }>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/members`)).items ?? [];
    },
    async listAgentRoomInvites(roomId) {
      return (await request<{ items: AgentRoomInvite[] }>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/agent-invites`)).items;
    },
    async createAgentRoomInvite(roomId, endpointId) {
      const { invite, invite_code } = await request<CreatedAgentRoomInvite>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/agent-invites`, { endpoint_id: endpointId });
      return { invite, invite_code };
    },
    async revokeAgentRoomInvite(roomId, inviteId) {
      await request<unknown>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/agent-invites/${encodeURIComponent(inviteId)}/revoke`);
    },
    async listRoomInvites(roomId) {
      return (await request<{ items: RoomInvite[] }>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/invites`)).items;
    },
    async createRoomInvite(roomId, name, role) {
      const { invite_id, link, token, admission } = await request<CreatedRoomInvite>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/invites`, { name, role, admission: 'request' });
      return { invite_id, role, admission, link, token };
    },
    async revokeRoomInvite(roomId, inviteId) {
      await request<unknown>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/invites/${encodeURIComponent(inviteId)}/revoke`);
    },
    async listJoinRequests(roomId) {
      const { pending, decided } = await request<JoinRequestQueue>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/join-requests`);
      return { pending, decided };
    },
    async decideJoinRequest(roomId, requestId, decision, role) {
      return (await request<{ request: JoinRequest }>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/join-requests/${encodeURIComponent(requestId)}/${decision}`, decision === 'accept' && role ? { role } : undefined)).request;
    },
    async listOwnJoinRequests() {
      return (await request<{ items: OwnJoinRequest[] }>('GET', '/v1/join-requests')).items;
    },
    async withdrawJoinRequest(requestId) {
      await request<unknown>('POST', `/v1/join-requests/${encodeURIComponent(requestId)}/withdraw`);
    },
    async listInvocations(roomId) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        // shortcut: a 500-row cap per active status; add pagination if a room may exceed the cap.
        const lists = await Promise.all((['queued', 'running'] as const).map((status) =>
          request<{ items: Invocation[] }>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/invocations?status=${status}&limit=500`, undefined, controller.signal),
        ));
        return lists.flatMap(({ items }) => items);
      } catch (error) {
        controller.abort();
        throw error;
      } finally {
        clearTimeout(timeout);
      }
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
    async listMentions(cursor) {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      return request<MentionPage>('GET', `/v1/mentions${query}`);
    },
    async roomKeys(roomId, endpointId) {
      return (await request<{ keys: RelayKey[] }>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/keys/${encodeURIComponent(endpointId)}`)).keys;
    },
    wsTicket() {
      return request<TicketResult>('POST', '/v1/rooms/ws-ticket');
    },
    me() {
      return request<Session>('GET', '/v1/auth/me');
    },
    async listContacts() {
      return (await request<{ items: Contact[] }>('GET', '/v1/me/contacts')).items;
    },
    async createContact(login, displayName) {
      return (await request<{ contact: Contact }>('POST', '/v1/me/contacts', { login, display_name: displayName })).contact;
    },
    async updateContact(contactId, displayName) {
      return (await request<{ contact: Contact }>('PUT', `/v1/me/contacts/${encodeURIComponent(contactId)}`, { display_name: displayName })).contact;
    },
    async deleteContact(contactId) {
      await request<void>('DELETE', `/v1/me/contacts/${encodeURIComponent(contactId)}`);
    },
    async logout() {
      await request<unknown>('POST', '/v1/auth/logout');
    },
  };
}
