export interface Room {
  conversation_id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  created_at: string;
  max_agent_turns: number;
}

export type RoomEventKind = 'router_decision' | 'invocation_refused' | 'invocation_stopped' | 'router_failed' | 'agent_cap_reached' | 'room_halted' | 'invocation_failed' | 'member_joined'
  | 'approval_requested' | 'approval_granted' | 'approval_cancelled' | 'approval_expired';

export interface RoomEnvelope {
  message_id: string;
  message_type: string;
  sender: { endpoint_id: string; owner_id: string };
  body: { text?: string; kind?: RoomEventKind | (string & {}); reason?: string; endpoint_ids?: string[]; invocation_id?: string; thread_root_id?: string; held_message_id?: string };
  created_at: string;
  signature?: EnvelopeSignature;
}

export interface EnvelopeSignature {
  algorithm: string | null;
  key_id: string | null;
  value: string | null;
}

export interface HistoryItem {
  room_seq: string | number;
  message_id: string;
  canonical_bytes: string | null;
  // Sender label from endpoints.display_name; absent on older relays.
  display_name?: string;
  envelope: RoomEnvelope;
}

// One row of GET /v1/mentions: a room.message whose mentions list names the caller.
export interface Mention {
  conversation_id: string;
  message_id: string;
  room_seq: string;
  sender_endpoint_id: string;
  text: string | null;
}

export interface MentionPage {
  items: Mention[];
  next_cursor: string | null;
}

export interface HistoryPage {
  code: string;
  items: HistoryItem[];
  next_after_seq: string | number;
  next_before_seq?: string | number | null;
  has_more?: boolean;
  has_older?: boolean;
}

export interface RoomSearchItem {
  room_seq: string | number;
  message_id: string;
  display_name?: string;
  sender_endpoint_id: string;
  created_at: string;
  snippet: string;
  thread_root_id?: string;
}

export interface RoomSearchPage {
  code: string;
  items: RoomSearchItem[];
  next_before_seq: string | number | null;
  has_more: boolean;
}

export interface SendResult {
  code: string;
  message_id: string;
  room_seq: string | number | null;
}

export interface AckResult {
  code: string;
  acknowledged: number;
}

export interface TicketResult {
  code: string;
  ticket: string;
  expires_at: string;
}

export interface RoomUpdatedFrame {
  type: 'room.updated';
  room_id: string;
  room_seq?: string | number;
  changed: 'messages' | 'members' | 'room' | 'join_requests' | 'approvals';
}

export type ResponseMode = 'joins' | 'mentions_only' | 'router' | 'report_only';

export type InvokableBy = 'owner' | 'members';

export interface Member {
  endpoint_id: string;
  role: 'owner' | 'room_manager' | 'member';
  response_mode: ResponseMode | null;
  added_at: string;
  invokable_by: InvokableBy;
  owner_id: string | null;
  display_name: string;
}

export interface AgentRoomInvite {
  invite_id: string;
  endpoint_id: string;
  created_at: string;
  expires_at: string;
  state: 'pending' | 'connected' | 'revoked' | 'expired';
}

export interface CreatedAgentRoomInvite {
  invite: AgentRoomInvite;
  invite_code: string;
}

export interface StopResult {
  code: string;
  cancelled: number;
}

export interface Invocation {
  invocation_id: string;
  endpoint_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'refused';
  subject_human_id: string | null;
}

export interface Session {
  human_id: string;
  endpoint_id: string;
  display_name: string;
  is_operator: boolean;
}

export interface Contact {
  contact_id: string;
  kind: 'endpoint' | 'human' | 'email';
  login: string;
  display_name: string;
  created_at: string;
  updated_at: string;
  endpoint_ids: string[];
}

export type GrantableRole = 'member' | 'room_manager';
export type JoinRequestStatus = 'pending' | 'accepted' | 'declined' | 'withdrawn' | 'expired';

export interface JoinRequest {
  request_id: string;
  room_id: string;
  requester_human_id: string;
  requester_endpoint_id: string;
  requester_name: string | null;
  offered_role: GrantableRole;
  status: JoinRequestStatus;
  decided_role: GrantableRole | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}

export interface JoinRequestQueue {
  pending: JoinRequest[];
  decided: JoinRequest[];
}

export interface OwnJoinRequest extends JoinRequest {
  room_name: string;
}

export interface RoomInvite {
  invite_id: string;
  name: string;
  role: GrantableRole;
  admission: 'direct' | 'request';
  created_by_human_id: string;
  created_at: string;
  expires_at: string;
  consumed_by_human_id: string | null;
  state: 'open' | 'used' | 'expired' | 'revoked';
}

export interface CreatedRoomInvite {
  invite_id: string;
  role: GrantableRole;
  admission: 'direct' | 'request';
  link: string | null;
  token: string;
}
