import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { RelayClient } from '../connectors/v1/relay-client.mjs';
import { LocalOutbox } from '../connectors/v1/local-outbox.mjs';
import { ConnectorDatabase } from '../connectors/v1/connector-db-adapter.mjs';
import { WebSocketConnectionManager } from '../connectors/v1/connector-ws-manager.mjs';
import { agentEnv } from '../bridges/v1/cli-runner.mjs';
import { identityKeys } from './identity.mjs';
import { logHop } from '../relay/v1/hop-log.mjs';

const defaultSchemaPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'connectors',
  'v1',
  'connector-schema.sql'
);

export function createAgentDaemon({
  identity,
  relayUrl,
  streamUrl,
  db = null,
  dbPath = null,
  schemaPath = null,
  workerCommand = process.execPath,
  workerArgs = [],
  autoReply = true,
  logger = console,
  // Stream frames drive the inbox. The timer only backs them up: every
  // safetyPollIntervalMs while the stream is open, every pollIntervalMs while
  // it is down or absent.
  pollIntervalMs = 15000,
  safetyPollIntervalMs = 60000,
  WebSocketImpl = WebSocket,
  heartbeatIntervalMs = 15000,
  missedHeartbeatsLimit = 3,
  onRoomMessage = null,
  onStart = null,
  onStop = null
} = {}) {
  if (!identity || !relayUrl) throw new Error('identity and relayUrl are required');

  const connectorDb = db ?? (dbPath ? new ConnectorDatabase(dbPath, schemaPath ?? defaultSchemaPath) : null);

  if (connectorDb) {
    connectorDb.upsertProfile({
      profile_id: `prof_${identity.endpoint_id}`,
      owner_id: identity.owner_id,
      endpoint_id: identity.endpoint_id,
      display_name: identity.endpoint_id,
      relay_url: relayUrl,
      status: 'active',
      secure_key_reference: `key://${identity.key_id || 'default'}`,
      secure_token_reference: `token://${identity.endpoint_id}`
    });
  }

  // A receive-only identity (written by `sigil bot add`) holds a relay token
  // and no private key: the relay signs for it. The signing outbox is built on
  // demand, so such an identity never reaches identityKeys().
  const receiveOnly = identity.receive_only === true;
  let outbox = null;
  function signingOutbox() {
    if (!outbox) {
      outbox = new LocalOutbox({
        privateKey: identityKeys(identity).privateKey,
        endpoint: {
          owner_id: identity.owner_id,
          endpoint_id: identity.endpoint_id,
          key_id: identity.key_id,
          kind: identity.kind
        }
      });
    }
    return outbox;
  }
  // Any other identity must sign, so a missing or corrupt key still stops the daemon at startup.
  if (!receiveOnly) signingOutbox();
  const relay = new RelayClient({ baseUrl: relayUrl, token: identity.relay_token });

  let running = false;
  let socket = null;
  let wsManager = null;
  let pollTimer = null;
  let heartbeatTimer = null;
  let since = '';
  let missedHeartbeats = 0;
  let reconnectDelay = 250;
  let reconnectTimer = null;

  async function executeWorker(taskPayload) {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(workerCommand, workerArgs, {
        env: agentEnv(process.env, { extraPrefixes: ['ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'OPENAI_', 'SIGIL_', 'OLLAMA_'] }),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      child.stdin.setEncoding('utf8');
      child.stdin.end(JSON.stringify(taskPayload));
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          const err = new Error(`Worker exited with code ${code}: ${stderr.trim() || stdout.trim() || 'unknown error'}`);
          err.code = 'WORKER_FAILED';
          return reject(err);
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (parseErr) {
          const err = new Error(`Worker returned invalid JSON: ${stdout.trim().slice(0, 200)}`);
          err.code = 'WORKER_INVALID_JSON';
          reject(err);
        }
      });
    });
  }

  // Delivery ids being processed right now: a frame-triggered poll and a timer
  // poll that overlap never hand the same delivery to the bridge twice.
  const inFlight = new Set();

  async function processItem(item) {
    const deliveryId = item.delivery_id;
    if (deliveryId && inFlight.has(deliveryId)) return { delivery_id: deliveryId, outcome: 'in_flight' };
    if (deliveryId) inFlight.add(deliveryId);
    try {
      return await processItemOnce(item);
    } finally {
      if (deliveryId) inFlight.delete(deliveryId);
    }
  }

  async function processItemOnce(item) {
    const deliveryId = item.delivery_id;
    const envelope = item.envelope ?? item;
    const messageType = envelope.message_type;

    if (connectorDb && envelope.message_id) {
      try {
        connectorDb.commitDurableInboxIntake(envelope, `prof_${identity.endpoint_id}`, new Date().toISOString());
      } catch (err) {
        logger.warn?.(`Durable intake write skipped: ${err.message}`);
      }
    }

    if (messageType === 'task.request' && receiveOnly) {
      // No key to sign a task.result with, and no local worker for a relay-held
      // bot: ack so the delivery does not return on every poll.
      logger.warn?.(`Receive-only identity ${identity.endpoint_id}: task.request ${envelope.message_id ?? deliveryId} acknowledged without a reply`);
      if (deliveryId) await relay.acknowledge(deliveryId, { outcome: 'acknowledged' }).catch(() => {});
      return { delivery_id: deliveryId, outcome: 'acknowledged' };
    }

    if (messageType === 'task.request') {
      try {
        if (deliveryId) {
          await relay.reportProcessing(deliveryId, 'processing').catch(() => {});
        }
        const taskResult = await executeWorker(envelope.body);
        if (autoReply && envelope.sender?.endpoint_id) {
          const now = new Date();
          const unsignedReply = {
            protocol: 'sigil/1',
            message_id: `msg_${crypto.randomUUID()}`,
            conversation_id: envelope.conversation_id,
            message_type: 'task.result',
            sender: {
              owner_id: identity.owner_id,
              endpoint_id: identity.endpoint_id,
              kind: identity.kind
            },
            recipient: {
              owner_id: envelope.sender.owner_id,
              endpoint_id: envelope.sender.endpoint_id
            },
            correlation_id: envelope.message_id,
            body: taskResult,
            context_refs: [],
            capabilities: [],
            idempotency_key: `reply_${envelope.message_id}`,
            created_at: now.toISOString(),
            expires_at: new Date(now.getTime() + 24 * 3600_000).toISOString(),
            signature: { algorithm: 'Ed25519', key_id: identity.key_id, value: '' }
          };
          const queued = signingOutbox().queue(unsignedReply);

          if (connectorDb) {
            try {
              connectorDb.queueOutboundMessage(
                `out_${queued.envelope.message_id}`,
                `prof_${identity.endpoint_id}`,
                queued.envelope
              );
            } catch (err) {
              logger.warn?.(`Outbox queue write error: ${err.message}`);
            }
          }

          await relay.sendEnvelope(queued.envelope);
          signingOutbox().markAccepted(queued.envelope.message_id);

          if (connectorDb) {
            connectorDb.updateOutboxDeliveryState(queued.envelope.message_id, {
              state: 'submitted',
              attemptIncrement: 1,
              lastAttemptAt: new Date().toISOString()
            });
          }
        }
        if (deliveryId) {
          await relay.reportProcessing(deliveryId, 'processed').catch(() => {});
        }
        if (connectorDb && envelope.message_id) {
          connectorDb.updateInboxProcessingState(envelope.message_id, 'processed');
        }
        return { delivery_id: deliveryId, outcome: 'processed', result: taskResult };
      } catch (err) {
        logger.error?.(`Daemon task processing failed: ${err.message}`, err);
        if (deliveryId) {
          await relay.reportProcessing(deliveryId, 'processing_failed', err.message).catch(() => {});
        }
        if (connectorDb && envelope.message_id) {
          connectorDb.updateInboxProcessingState(envelope.message_id, 'failed');
        }
        return { delivery_id: deliveryId, outcome: 'processing_failed', error: err.message };
      }
    }

    if (messageType === 'room.message' && onRoomMessage) {
      // The bridge fails its own invocation for any error once it knows the
      // invocation. A throw here means it never got that far (the invocation
      // lookup failed), so the delivery stays unacked for the next poll.
      logHop('bridge.delivery_picked', { endpoint_id: identity.endpoint_id, delivery_id: deliveryId ?? null, message_id: envelope.message_id ?? null, room_id: envelope.conversation_id ?? null }, logger);
      let outcome;
      try {
        outcome = (await onRoomMessage({ deliveryId, envelope }))?.outcome ?? 'failed';
      } catch (err) {
        logger.error?.(`Room bridge failed before its invocation was known; delivery left for the next poll: ${err.message}`, err);
        return { delivery_id: deliveryId, outcome: 'room_unacked' };
      }
      if (deliveryId) await relay.acknowledge(deliveryId, { outcome: 'acknowledged' }).catch(() => {});
      return { delivery_id: deliveryId, outcome: `room_${outcome}` };
    }

    if (deliveryId) {
      await relay.acknowledge(deliveryId, { outcome: 'acknowledged' }).catch(() => {});
    }
    return { delivery_id: deliveryId, outcome: 'acknowledged' };
  }

  // One poll at a time. A trigger that lands mid-poll sets `again`, so the
  // poll runs once more instead of dropping a delivery queued after its read.
  let polling = null;
  let again = false;
  function poll() {
    if (polling) { again = true; return polling; }
    polling = (async () => {
      let total = 0;
      do {
        again = false;
        total += await pollOnce();
      } while (again);
      return total;
    })().finally(() => { polling = null; });
    return polling;
  }

  async function pollOnce() {
    try {
      const page = await relay.reconcileInbox(since);
      let leftUnacked = false;
      for (const item of page.items) {
        if ((await processItem(item))?.outcome === 'room_unacked') leftUnacked = true;
      }
      // The inbox cursor is queued_at-based; advancing past an unacked
      // delivery would hide it until restart. Acked items do not come back.
      if (!leftUnacked) since = page.nextSince ?? since;
      return page.items.length;
    } catch (err) {
      logger.error?.(`Daemon inbox poll error: ${err.message}`);
      return 0;
    }
  }

  let ready = false;
  let streamOpen = false;
  function trigger() {
    if (!running || !ready) return;
    poll();
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    if (!running) return;
    const interval = streamOpen ? safetyPollIntervalMs : pollIntervalMs;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (ready) poll();
      schedulePoll();
    }, interval);
  }

  // Frames that can mean new inbox work for this endpoint.
  const TRIGGER_FRAMES = new Set(['delivered', 'resend', 'sequence_reset']);

  function start() {
    if (running) return;
    running = true;
    const begin = () => { ready = true; poll(); };
    if (onStart) {
      // The first poll waits for the start hook (the Floor Warden bridge's
      // recover()), so recovery does not race the first forward.
      Promise.resolve()
        .then(() => onStart())
        .catch((err) => logger.error?.(`Daemon start hook failed: ${err?.message ?? String(err)}`))
        .finally(() => { if (running) begin(); });
    } else {
      begin();
    }

    if (streamUrl) {
      const connectSocket = () => {
        if (!running) return;
        const current = new WebSocketImpl(streamUrl, {
          headers: { authorization: `Bearer ${identity.relay_token}` }
        });
        socket = current;
        current.on('open', () => {
          missedHeartbeats = 0;
          reconnectDelay = 250;
          streamOpen = true;
          logger.info?.('Relay stream connected; inbox is event-driven');
          schedulePoll();
          // Anything queued while the stream was down.
          trigger();
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = setInterval(() => {
            if (current.readyState === WebSocket.OPEN) {
              missedHeartbeats += 1;
              if (missedHeartbeats >= missedHeartbeatsLimit) {
                logger.warn?.('Relay heartbeat timeout; reconnecting stream...');
                current.terminate();
                return;
              }
              current.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() }));
            }
          }, heartbeatIntervalMs);
        });
        current.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(raw); } catch { return; }
          missedHeartbeats = 0;
          if (msg.type === 'pong') return;
          if (TRIGGER_FRAMES.has(msg.type)) {
            logHop('bridge.stream_frame', { endpoint_id: identity.endpoint_id, type: msg.type, delivery_id: msg.delivery_id ?? null }, logger);
            trigger();
          }
        });
        current.on('close', () => {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          if (socket === current) socket = null;
          const wasOpen = streamOpen;
          streamOpen = false;
          if (!running) return;
          if (wasOpen) {
            logger.warn?.(`Relay stream closed; polling every ${pollIntervalMs} ms until it reconnects`);
            schedulePoll();
          }
          reconnectTimer = setTimeout(() => { reconnectTimer = null; connectSocket(); }, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        });
        current.on('error', () => {
          try { current.close(); } catch {}
        });
      };
      connectSocket();
    }

    schedulePoll();
  }

  function stop() {
    running = false;
    // Always runs (idempotent hooks): a caller may stop a daemon it only polled.
    if (onStop) {
      try { onStop(); } catch (err) { logger.error?.(`Daemon stop hook failed: ${err?.message ?? String(err)}`); }
    }
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (socket) {
      try { socket.close(); } catch {}
      socket = null;
    }
    if (wsManager) {
      wsManager.close();
      wsManager = null;
    }
  }

  return {
    start,
    stop,
    get streamOpen() { return streamOpen; },
    poll,
    processItem,
    executeWorker,
    get db() { return connectorDb; }
  };
}
