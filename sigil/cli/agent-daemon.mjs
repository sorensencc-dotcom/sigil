import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { RelayClient } from '../connectors/v1/relay-client.mjs';
import { LocalOutbox } from '../connectors/v1/local-outbox.mjs';
import { identityKeys } from './identity.mjs';

export function createAgentDaemon({
  identity,
  relayUrl,
  streamUrl,
  workerCommand = process.execPath,
  workerArgs = [],
  autoReply = true,
  logger = console,
  pollIntervalMs = 15000,
  heartbeatIntervalMs = 15000,
  missedHeartbeatsLimit = 3
} = {}) {
  if (!identity || !relayUrl) throw new Error('identity and relayUrl are required');

  const keys = identityKeys(identity);
  const outbox = new LocalOutbox({
    privateKey: keys.privateKey,
    endpoint: {
      owner_id: identity.owner_id,
      endpoint_id: identity.endpoint_id,
      key_id: identity.key_id,
      kind: identity.kind
    }
  });
  const relay = new RelayClient({ baseUrl: relayUrl, token: identity.relay_token });

  let running = false;
  let socket = null;
  let pollTimer = null;
  let heartbeatTimer = null;
  let since = '';
  let missedHeartbeats = 0;

  async function executeWorker(taskPayload) {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(workerCommand, workerArgs, {
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

  async function processItem(item) {
    const deliveryId = item.delivery_id;
    const envelope = item.envelope ?? item;
    const messageType = envelope.message_type;

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
            idempotency_key: `reply_${crypto.randomUUID()}`,
            created_at: now.toISOString(),
            expires_at: new Date(now.getTime() + 24 * 3600_000).toISOString(),
            signature: { algorithm: 'Ed25519', key_id: identity.key_id, value: '' }
          };
          const queued = outbox.queue(unsignedReply);
          await relay.sendEnvelope(queued.envelope);
          outbox.markAccepted(queued.envelope.message_id);
        }
        if (deliveryId) {
          await relay.acknowledge(deliveryId, { outcome: 'processed' });
        }
        return { delivery_id: deliveryId, outcome: 'processed', result: taskResult };
      } catch (err) {
        if (deliveryId) {
          await relay.acknowledge(deliveryId, { outcome: 'processing_failed', reason: err.message }).catch(() => {});
        }
        return { delivery_id: deliveryId, outcome: 'processing_failed', error: err.message };
      }
    }

    if (deliveryId) {
      await relay.acknowledge(deliveryId, { outcome: 'acknowledged' }).catch(() => {});
    }
    return { delivery_id: deliveryId, outcome: 'acknowledged' };
  }

  async function poll() {
    try {
      const page = await relay.reconcileInbox(since);
      for (const item of page.items) {
        await processItem(item);
      }
      since = page.nextSince ?? since;
      return page.items.length;
    } catch (err) {
      logger.error?.(`Daemon inbox poll error: ${err.message}`);
      return 0;
    }
  }

  function start() {
    if (running) return;
    running = true;
    poll();

    if (streamUrl) {
      const connectSocket = () => {
        if (!running) return;
        socket = new WebSocket(streamUrl, {
          headers: { authorization: `Bearer ${identity.relay_token}` }
        });
        socket.on('open', () => {
          missedHeartbeats = 0;
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = setInterval(() => {
            if (socket?.readyState === WebSocket.OPEN) {
              missedHeartbeats += 1;
              if (missedHeartbeats >= missedHeartbeatsLimit) {
                logger.warn?.('Relay heartbeat timeout; reconnecting stream...');
                socket.terminate();
                return;
              }
              socket.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() }));
            }
          }, heartbeatIntervalMs);
        });
        socket.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw);
            if (msg.type === 'pong') {
              missedHeartbeats = 0;
            } else if (msg.type === 'delivered') {
              poll();
            }
          } catch {}
        });
        socket.on('close', () => {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          if (running) setTimeout(connectSocket, 1000);
        });
        socket.on('error', () => {
          try { socket.close(); } catch {}
        });
      };
      connectSocket();
    }

    pollTimer = setInterval(poll, pollIntervalMs);
  }

  function stop() {
    running = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (socket) {
      try { socket.close(); } catch {}
      socket = null;
    }
  }

  return {
    start,
    stop,
    poll,
    processItem,
    executeWorker
  };
}
