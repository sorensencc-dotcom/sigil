import WebSocket from 'ws';
import { EventEmitter } from 'events';

/**
 * WebSocketConnectionManager maintains resilient relay connectivity,
 * guarantees durable-before-ack inbox intake, and flushes outbox messages.
 */
export class WebSocketConnectionManager extends EventEmitter {
  /**
   * @param {Object} options
   * @param {import('./connector-db-adapter.mjs').ConnectorDatabase} options.db
   * @param {string} options.profileId
   * @param {string} options.bearerToken
   * @param {number} [options.heartbeatIntervalMs=15000]
   * @param {number} [options.outboxSweepIntervalMs=2000]
   */
  constructor({
    db,
    profileId,
    bearerToken,
    heartbeatIntervalMs = 15000,
    outboxSweepIntervalMs = 2000,
  }) {
    super();
    this.db = db;
    this.profileId = profileId;
    this.bearerToken = bearerToken;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.outboxSweepIntervalMs = outboxSweepIntervalMs;

    this.ws = null;
    this.isConnected = false;
    this.isShuttingDown = false;
    this.reconnectAttempts = 0;
    this.heartbeatTimer = null;
    this.outboxTimer = null;
  }

  /**
   * Starts connection lifecycle and background queue pollers.
   */
  start() {
    this.isShuttingDown = false;
    this.connect();
    this.startOutboxSweepLoop();
  }

  /**
   * Establishes authenticated WebSocket session to the configured relay URL.
   */
  connect() {
    if (this.isShuttingDown) return;

    const profile = this.db.getProfile(this.profileId);
    if (!profile) {
      throw new Error(`Profile not found for ID: ${this.profileId}`);
    }

    const wsUrl = new URL(profile.relay_url);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('endpoint_id', profile.endpoint_id);

    this.ws = new WebSocket(wsUrl.toString(), {
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        'X-Sigil-Endpoint-Id': profile.endpoint_id,
      },
    });

    this.ws.on('open', () => this.handleOpen());
    this.ws.on('message', (data) => this.handleMessage(data));
    this.ws.on('pong', () => this.handlePong());
    this.ws.on('close', (code, reason) => this.handleClose(code, reason));
    this.ws.on('error', (error) => this.handleError(error));
  }

  handleOpen() {
    this.isConnected = true;
    this.reconnectAttempts = 0;
    this.emit('connected');

    this.startHeartbeat();
    this.flushOutbox();
  }

  handleClose(code, reason) {
    this.isConnected = false;
    this.stopHeartbeat();
    this.emit('disconnected', { code, reason: reason ? reason.toString() : '' });

    if (!this.isShuttingDown) {
      this.scheduleReconnect();
    }
  }

  handleError(error) {
    this.emit('error', error);
  }

  /**
   * Processes inbound frames according to the Durable-Before-Ack protocol.
   * @param {Buffer|string} data
   */
  handleMessage(data) {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      this.emit('error', new Error('Malformed JSON payload received from relay'));
      return;
    }

    switch (frame.action) {
      case 'delivery':
        this.processInboundEnvelope(frame.payload);
        break;

      case 'receipt':
        this.processOutboundReceipt(frame.payload);
        break;

      case 'pong':
        this.emit('heartbeat_acknowledged');
        break;

      default:
        this.emit('unhandled_frame', frame);
    }
  }

  /**
   * Commits the envelope to SQLite before transmitting the intake acknowledgement.
   * @param {Object} envelope
   */
  processInboundEnvelope(envelope) {
    const reconciledAt = new Date().toISOString();

    try {
      // 1. Commit durable local storage record
      this.db.commitDurableInboxIntake(envelope, this.profileId, reconciledAt);

      // 2. Transmit protocol acknowledgement frame
      this.sendFrame({
        action: 'acknowledge',
        payload: {
          message_id: envelope.message_id,
          reconciled_at: reconciledAt,
        },
      });

      this.emit('message_received', envelope);
    } catch (err) {
      this.emit('error', new Error(`Durable intake failed for message ${envelope.message_id}: ${err.message}`));
    }
  }

  /**
   * Applies delivery state transitions to outbox entries from relay receipt events.
   * @param {Object} receipt
   */
  processOutboundReceipt(receipt) {
    const { message_id, state, failure_code } = receipt;

    this.db.updateOutboxDeliveryState(message_id, {
      state,
      attemptIncrement: 0,
      lastAttemptAt: new Date().toISOString(),
      failureCode: failure_code || null,
    });

    this.emit('receipt_processed', receipt);
  }

  /**
   * Sweeps SQLite outbox and transmits queued envelopes over the active WebSocket.
   */
  flushOutbox() {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const pending = this.db.getPendingOutboundQueue();

    for (const item of pending) {
      const nowIso = new Date().toISOString();

      try {
        this.sendFrame({
          action: 'submit',
          payload: {
            outbox_id: item.outbox_id,
            message_id: item.message_id,
            conversation_id: item.conversation_id,
            message_type: item.message_type,
            recipient_endpoint_id: item.recipient_endpoint_id,
            body: JSON.parse(item.body_json),
            canonical_hash: item.canonical_hash,
            signature_value: item.signature_value,
            idempotency_key: item.idempotency_key,
            expires_at: item.expires_at,
          },
        });

        this.db.updateOutboxDeliveryState(item.message_id, {
          state: 'submitted',
          attemptIncrement: 1,
          lastAttemptAt: nowIso,
          failureCode: null,
        });
      } catch (err) {
        this.db.updateOutboxDeliveryState(item.message_id, {
          state: 'failed',
          attemptIncrement: 1,
          lastAttemptAt: nowIso,
          failureCode: err.message,
        });
      }
    }
  }

  sendFrame(frame) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  handlePong() {
    this.emit('heartbeat');
  }

  startOutboxSweepLoop() {
    this.outboxTimer = setInterval(() => {
      this.flushOutbox();
    }, this.outboxSweepIntervalMs);
  }

  scheduleReconnect() {
    this.reconnectAttempts += 1;
    // Jittered exponential backoff capped at 30 seconds
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000, 30000);

    setTimeout(() => {
      if (!this.isShuttingDown && !this.isConnected) {
        this.connect();
      }
    }, delay);
  }

  /**
   * Performs graceful connection shutdown.
   */
  close() {
    this.isShuttingDown = true;
    this.stopHeartbeat();

    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Client shutting down');
      this.ws = null;
    }

    this.isConnected = false;
  }
}
