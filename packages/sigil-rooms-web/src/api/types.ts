export interface Room {
  conversation_id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  created_at: string;
  max_agent_turns: number;
}

export interface RoomEnvelope {
  message_id: string;
  message_type: string;
  sender: { endpoint_id: string; owner_id: string };
  body: { text?: string; kind?: string; reason?: string; endpoint_ids?: string[] };
  created_at: string;
}

export interface HistoryItem {
  room_seq: string | number;
  message_id: string;
  canonical_bytes: string;
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
  changed: 'messages' | 'members';
}
