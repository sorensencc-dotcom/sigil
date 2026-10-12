import pg from 'pg';
import { notifyRoomHumans } from './room-notify.mjs';

// CLI processes reach a running relay through this channel (foundation spec,
// "Reaching the running relay"). Publishers call pg_notify inside their own
// transaction, so Postgres delivers only on commit.
export const ADMIN_CHANNEL = 'sigil_admin';
export const ADMIN_LISTENER_APPLICATION_NAME = 'sigil-admin-listener';
const TYPES = new Set(['human.provisioned', 'room.members', 'human.suspended', 'human.unsuspended', 'agent.invokable', 'endpoint.revoked', 'identity.revoked']);
const REVALIDATING_TYPES = new Set(['human.suspended', 'endpoint.revoked', 'identity.revoked']);
const MAX_PAYLOAD_BYTES = 8000;
const MAX_BACKOFF_MS = 5000;

export async function publishAdmin(client, payload) {
  if (!TYPES.has(payload?.type)) throw Object.assign(new Error(`unknown admin type ${payload?.type}`), { code: 'INVALID_ADMIN_TYPE' });
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) >= MAX_PAYLOAD_BYTES) throw Object.assign(new Error('admin payload too large'), { code: 'PAYLOAD_TOO_LARGE' });
  await client.query('SELECT pg_notify($1, $2)', [ADMIN_CHANNEL, body]);
}

const optionalString = (value) => value === undefined || (typeof value === 'string' && value.length > 0);

// Anyone with database access can NOTIFY this channel, so a payload is
// untrusted input: anything outside the fixed shape is dropped.
export function parseAdminPayload(raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { return null; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !TYPES.has(payload.type)) return null;
  if (!optionalString(payload.human_id) || !optionalString(payload.endpoint_id)) return null;
  if (payload.room_ids !== undefined && !(Array.isArray(payload.room_ids) && payload.room_ids.every((id) => typeof id === 'string' && id.length > 0))) return null;
  const parsed = { type: payload.type };
  for (const key of ['human_id', 'endpoint_id', 'room_ids']) if (payload[key] !== undefined) parsed[key] = payload[key];
  return parsed;
}

export function createAdminMessageHandler({ auth, stream, repository, registered = undefined, logger = console }) {
  return async (message) => {
    const target = { humanId: message.human_id, endpointId: message.endpoint_id };
    auth?.clear?.(target);
    if (REVALIDATING_TYPES.has(message.type)) await stream?.revalidate?.(target);
    for (const roomId of message.room_ids ?? []) {
      // notifyRoomHumans needs a real client: with client null its member read
      // throws in Postgres mode and nothing is sent.
      await repository.withTransaction((client) => notifyRoomHumans({ repository, stream, registered, client, roomId, changed: 'members', logger }));
    }
  };
}

// One dedicated connection (not a pool client) holds LISTEN. On error or end
// it reconnects with doubling backoff and calls onReconnect, because any
// notification sent while disconnected is lost.
export async function startAdminListener({ pool, onMessage, onReconnect = () => {}, logger = console, backoffMs = 100 }) {
  let closed = false;
  let client = null;
  let timer = null;
  let delay = backoffMs;

  const connect = async () => {
    const next = new pg.Client({ ...pool.options, application_name: ADMIN_LISTENER_APPLICATION_NAME });
    next.on('notification', (notification) => {
      if (notification.channel !== ADMIN_CHANNEL) return;
      const message = parseAdminPayload(notification.payload);
      if (!message) { logger?.warn?.({ event: 'admin.payload_ignored' }); return; }
      Promise.resolve().then(() => onMessage(message)).catch((error) => logger?.error?.({ event: 'admin.handler_failed', type: message.type, error: error?.message }));
    });
    let dropped = false;
    const drop = (error) => {
      if (dropped) return;
      dropped = true;
      if (closed) return;
      logger?.warn?.({ event: 'admin.listener_dropped', error: error?.message });
      next.end().catch(() => {});
      scheduleReconnect();
    };
    next.on('error', drop);
    next.on('end', () => drop());
    try {
      await next.connect();
      await next.query(`LISTEN ${ADMIN_CHANNEL}`);
    } catch (error) {
      drop(error);
      throw error;
    }
    if (closed) { await next.end().catch(() => {}); return; }
    client = next;
  };

  const scheduleReconnect = () => {
    if (closed || timer) return;
    const wait = delay;
    delay = Math.min(delay * 2, MAX_BACKOFF_MS);
    timer = setTimeout(async () => {
      timer = null;
      try {
        await connect();
        delay = backoffMs;
        if (!closed) await onReconnect();
      } catch {
        // connect's drop handler already scheduled the next attempt.
      }
    }, wait);
    timer.unref?.();
  };

  const close = async () => {
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    await client?.end().catch(() => {});
  };
  // A first connection that fails is a startup error, not something to retry quietly.
  try { await connect(); } catch (error) { await close(); throw error; }
  return {
    close,
  };
}
