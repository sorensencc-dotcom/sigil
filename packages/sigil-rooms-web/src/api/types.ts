export interface Room {
  conversation_id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  created_at: string;
  max_agent_turns: number;
}

export type RoomEventKind = 'router_decision' | 'invocation_refused' | 'invocation_stopped' | 'router_failed' | 'agent_cap_reached' | 'room_halted' | 'invocation_failed';

export interface RoomEnvelope {
  message_id: string;
  message_type: string;
  sender: { endpoint_id: string; owner_id: string };
  body: { text?: string; kind?: RoomEventKind | (string & {}); reason?: string; endpoint_ids?: string[]; invocation_id?: string; thread_root_id?: string };
  created_at: string;
}

export interface HistoryItem {
  room_seq: string | number;
  message_id: string;
  canonical_bytes: string;
  // Sender label from endpoints.display_name; absent on older relays.
  display_name?: string;
  envelope: RoomEnvelope;
}

export interface HistoryPage {
  code: string;
  items: HistoryItem[];
  next_after_seq: string | number;
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
  changed: 'messages' | 'members' | 'room';
}

export type ResponseMode = 'joins' | 'mentions_only' | 'router';

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

export interface StopResult {
  code: string;
  cancelled: number;
}

export interface Session {
  human_id: string;
  endpoint_id: string;
  display_name: string;
  is_operator: boolean;
}
