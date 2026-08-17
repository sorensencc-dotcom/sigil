import { WebSocket as DefaultWebSocket } from 'ws';
import { appendInboxLedger } from './ledger.mjs';
import { resolveHeartbeat } from '../relay/v1/relay-config.mjs';

export const INBOX_WAIT_EXIT_CODES = Object.freeze({ TIMEOUT: 2, AUTH: 3, CONNECTION: 4, MALFORMED: 5, RELAY_UNREACHABLE: 6, SIGINT: 130, SIGTERM: 143 });

export class InboxWaitError extends Error {
  constructor(message, exitCode, options = {}) { super(message, options); this.name = 'InboxWaitError'; this.exitCode = exitCode; }
}

function classifyRelayError(error) {
  if (error?.status === 401 || error?.code === 'AUTHENTICATION_REQUIRED' || error?.code === 'AUTH_REQUIRED') {
    return new InboxWaitError(error.message || 'Authentication required', INBOX_WAIT_EXIT_CODES.AUTH, { cause: error });
  }
  return new InboxWaitError(error?.message || 'Relay connection failed', INBOX_WAIT_EXIT_CODES.CONNECTION, { cause: error });
}

export function formatInboxItem(item) {
  const envelope = item?.envelope ?? item;
  if (!envelope || typeof envelope !== 'object' || typeof envelope.created_at !== 'string' ||
      typeof envelope.sender?.endpoint_id !== 'string' || typeof envelope.message_type !== 'string' ||
      !('body' in envelope)) throw new InboxWaitError('Malformed delivered message', INBOX_WAIT_EXIT_CODES.MALFORMED);
  return `[${envelope.created_at}] ${envelope.sender.endpoint_id} -> ${envelope.recipient?.endpoint_id ?? '(broadcast)'} (${envelope.message_type}): ${JSON.stringify(envelope.body)}`;
}

export async function waitForOneInboxMessage({ relay, identity, streamUrl, timeoutMs = 300_000, WebSocketImpl = DefaultWebSocket, print = console.log, signalSource = process, ledgerPath, heartbeat: heartbeatOverrides } = {}) {
  const heartbeat = resolveHeartbeat(heartbeatOverrides);
  if (!relay || !identity?.relay_token || !streamUrl) throw new Error('relay, identity, and streamUrl are required');
  let socket; let stopped = false; let reconnectTimer; let fallbackTimer; let timeoutTimer; let heartbeatTimer; let missedHeartbeats = 0; let reconnectDelay = 250; let polling = false;
  let resolveWait; let rejectWait;
  const wait = new Promise((resolve, reject) => { resolveWait = resolve; rejectWait = reject; });
  // Attach a handler immediately because timeout/socket callbacks can settle
  // the promise before the async control path reaches its final await.
  wait.catch(() => {});
  // SIGINT/SIGTERM must not acknowledge anything -- fail() only rejects and
  // cleans up, it never touches the relay, so a signal mid-wait is always safe.
  const onSigint = () => fail(new InboxWaitError('Interrupted', INBOX_WAIT_EXIT_CODES.SIGINT));
  const onSigterm = () => fail(new InboxWaitError('Terminated', INBOX_WAIT_EXIT_CODES.SIGTERM));
  signalSource.once('SIGINT', onSigint);
  signalSource.once('SIGTERM', onSigterm);
  const cleanup = () => {
    stopped = true;
    clearTimeout(reconnectTimer); clearInterval(fallbackTimer); clearTimeout(timeoutTimer);
    clearInterval(heartbeatTimer);
    signalSource.removeListener('SIGINT', onSigint); signalSource.removeListener('SIGTERM', onSigterm);
    try { socket?.close(); socket?.terminate?.(); } catch {}
  };
  const fail = (error) => { cleanup(); rejectWait(error); };
  const finish = () => { cleanup(); resolveWait(); };
  const poll = async () => {
    if (stopped || polling) return false;
    polling = true;
    try {
      // Empty cursor is intentional: ack state, not a cursor advanced past
      // other page items, determines what the next invocation receives.
      const page = await relay.reconcileInbox('');
      // A timeout or signal can settle `wait` (fail()) while this request was
      // in flight -- stopped is now true. Printing/acking after that would
      // consume a message the caller already believes was never delivered.
      if (stopped) return false;
      const item = page.items?.[0];
      if (!item) return false;
      const output = formatInboxItem(item);
      if (ledgerPath) {
        await appendInboxLedger(ledgerPath, {
          received_at: new Date().toISOString(),
          delivery_id: item.delivery_id,
          envelope: item.envelope ?? item,
        });
      }
      await print(output);
      if (stopped) return false;
      if (item.delivery_id) await relay.acknowledge(item.delivery_id);
      if (stopped) return false;
      finish();
      return true;
    } catch (error) {
      fail(error instanceof InboxWaitError ? error : classifyRelayError(error));
      return false;
    } finally { polling = false; }
  };
  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  };
  const connect = () => {
    if (stopped) return;
    try {
      socket = new WebSocketImpl(streamUrl, { headers: { authorization: `Bearer ${identity.relay_token}` } });
      let opened = false;
      socket.once('open', () => { opened = true; reconnectDelay = 250; missedHeartbeats = 0; clearInterval(heartbeatTimer); heartbeatTimer = setInterval(() => { missedHeartbeats += 1; if (missedHeartbeats >= heartbeat.missedBeforeTimeout) return fail(new InboxWaitError('Relay unreachable: no heartbeat reply', INBOX_WAIT_EXIT_CODES.RELAY_UNREACHABLE)); try { socket.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() })); } catch {} }, heartbeat.intervalMs); });
      socket.on('message', (raw) => {
        try { const event = JSON.parse(raw); if (event.type === 'delivered') poll(); if (event.type === 'pong') missedHeartbeats = 0; }
        catch (error) { fail(new InboxWaitError(`Malformed stream event: ${error.message}`, INBOX_WAIT_EXIT_CODES.MALFORMED, { cause: error })); }
      });
      socket.once('unexpected-response', (_request, response) => {
        if (response.statusCode === 401) fail(new InboxWaitError('Authentication required', INBOX_WAIT_EXIT_CODES.AUTH));
        else fail(new InboxWaitError(`Stream connection failed: HTTP ${response.statusCode}`, INBOX_WAIT_EXIT_CODES.CONNECTION));
      });
      socket.once('error', (error) => { try { socket.close(); } catch {}; if (!stopped && !opened) fail(new InboxWaitError(error?.message || 'Stream connection failed', INBOX_WAIT_EXIT_CODES.CONNECTION, { cause: error })); else if (!stopped) scheduleReconnect(); });
      socket.once('close', () => { if (!stopped) scheduleReconnect(); });
    } catch (error) { fail(classifyRelayError(error)); }
  };
  timeoutTimer = setTimeout(() => fail(new InboxWaitError('Inbox wait timed out', INBOX_WAIT_EXIT_CODES.TIMEOUT)), timeoutMs);
  if (await poll()) return;
  if (stopped) { await wait; return; }
  fallbackTimer = setInterval(() => { poll(); }, 30_000);
  connect();
  await wait;
}
