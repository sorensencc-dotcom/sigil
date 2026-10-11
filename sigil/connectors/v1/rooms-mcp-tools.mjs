import crypto from 'node:crypto';

const TEXT_MAX = 16000;
const REPLY_TTL_MS = 24 * 3600_000;

function invalid(message) { return Object.assign(new Error(message), { code: 'INVALID_REQUEST' }); }

export function createRoomsRuntime({ relay, outbox, now = () => new Date() }) {
  return {
    async listRooms() { return (await relay.request('/v1/rooms')).items; },

    async readRoom({ room_id, after_seq = '0', limit = 50 }) {
      if (!room_id) throw invalid('room_id is required');
      return relay.listRoomMessages(room_id, String(after_seq), limit);
    },

    async postMessage({ room_id, text, thread_root_id = null, mentions = [], idempotency_key }) {
      if (!room_id) throw invalid('room_id is required');
      if (typeof text !== 'string' || !text.trim() || text.length > TEXT_MAX) throw invalid(`text must be 1 to ${TEXT_MAX} characters`);
      const created = now();
      const { envelope } = outbox.queue({
        protocol: 'sigil/1',
        message_id: `msg_${crypto.randomUUID()}`,
        conversation_id: room_id,
        message_type: 'room.message',
        broadcast_scope: { conversation_id: room_id },
        correlation_id: null,
        body: { text, thread_root_id, mentions },
        context_refs: [],
        capabilities: [],
        idempotency_key: `mcp_post_${idempotency_key ?? crypto.randomUUID()}`,
        created_at: created.toISOString(),
        expires_at: new Date(created.getTime() + REPLY_TTL_MS).toISOString(),
      });
      return relay.sendEnvelope(envelope);
    },

    async dispatchTask({ room_id, task_id, instruction, assignee, thread_root_id = null, idempotency_key, success_criteria, dependencies, deadline }) {
      if (!room_id) throw invalid('room_id is required');
      if (typeof task_id !== 'string' || !task_id) throw invalid('task_id is required');
      if (typeof instruction !== 'string' || !instruction.trim()) throw invalid('instruction is required');
      if (typeof assignee !== 'string' || !assignee) throw invalid('assignee is required');
      const body = { task_id, instruction, assignee, thread_root_id };
      if (success_criteria !== undefined) body.success_criteria = success_criteria;
      if (dependencies !== undefined) body.dependencies = dependencies;
      if (deadline !== undefined) body.deadline = deadline;
      const created = now();
      const { envelope } = outbox.queue({
        protocol: 'sigil/1',
        message_id: `msg_${crypto.randomUUID()}`,
        conversation_id: room_id,
        message_type: 'task.request',
        broadcast_scope: { conversation_id: room_id },
        correlation_id: null,
        body,
        context_refs: [],
        capabilities: [],
        idempotency_key: `mcp_task_${idempotency_key ?? crypto.randomUUID()}`,
        created_at: created.toISOString(),
        expires_at: new Date(created.getTime() + REPLY_TTL_MS).toISOString(),
      });
      return relay.sendEnvelope(envelope);
    },

    async myMentions({ limit = 50 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('limit must be an integer from 1 to 100');
      return (await relay.request(`/v1/mentions?limit=${limit}`)).items;
    },
  };
}
