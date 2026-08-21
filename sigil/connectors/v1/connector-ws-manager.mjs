import WebSocket from 'ws';
import { EventEmitter } from 'events';

/**
 * ConnectorWebSocketManager coordinates active client-side WebSocket connections
 * with the Sigil Relay. It handles real-time application-level heartbeats (ping/pong),
 * exponential backoff reconnects, and maps incoming stream event receipts back to
 * the local SQLite ConnectorDatabase outbox.
 */
export class ConnectorWebSocketManager extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} [options.wsUrl] - The Sigil Relay stream WebSocket URL
   * @param {string} [options.authToken] - The bearer authorization token
   * @param {string} options.profileId - Local profile ID the manager is serving
   * @param {import('./connector-db-adapter.mjs').ConnectorDatabase} [options.dbAdapter] - Instantiated ConnectorDatabase adapter
   * @param {import('./connector-db-adapter.mjs').ConnectorDatabase} [options.db] - Alias for dbAdapter
   * @param {string} [options.bearerToken] - Alias for authToken
   * @param {Object} [options.heartbeat] - Override heartbeat defaults
   * @param {number} [options.heartbeat.intervalMs=15000] - Interval between pings (15s default)
   * @param {number} [options.heartbeat.timeoutMs=45000] - Duration to declare timeout (45s default)
   * @param {number} [options.heartbeat.maxMissed=3] - Maximum missed pings before exit
   * @param {number} [options.heartbeatIntervalMs] - Direct ping interval setting
   * @param {number} [options.outboxSweepIntervalMs=2000] - Outbox retry/flush interval
   */
  constructor({
    wsUrl,
    authToken,
    profileId,
    dbAdapter,
    db,
    bearerToken,
    heartbeat = {},
    heartbeatIntervalMs,
    outboxSweepIntervalMs = 2000,
  } = {}) {
    super();
    this.wsUrl = wsUrl;
    this.authToken = authToken || bearerToken;
    this.profileId = profileId;
    this.db = dbAdapter || db;

    if (!this.db) {
      throw new Error('Database adapter (db/dbAdapter) is required to guarantee durable-before-ack delivery intake');
    }

    // Conformance Liveness Limits (Default: Ping every 15s, Timeout after 3 missed pongs = 45s)
    this.pingIntervalMs = heartbeatIntervalMs || heartbeat.intervalMs || 15000;
    this.maxMissedPongs = heartbeat.maxMissed || 3;
    this.outboxSweepIntervalMs = outboxSweepIntervalMs;

    this.ws = null;
    this.pingTimer = null;
    this.outboxTimer = null;
    this.missedPongs = 0;
    this.reconnectAttempts = 0;
    this.maxReconnectDelayMs = 30000; // Cap exponential backoff at 30 seconds
    this.isClosedPurposely = false;
    this.isConnected = false;

    // Bound listeners to maintain execution context
    this._onOpen = this._onOpen.bind(this);
    this._onMessage = this._onMessage.bind(this);
    this._onClose = this._onClose.bind(this);
    this._onError = this._onError.bind(this);
  }

  /**
   * Starts connection lifecycle and background queue pollers.
   */
  start() {
    this.connect();
    this.startOutboxSweepLoop();
  }

  /**
   * Initiates the WebSocket transport connection.
   */
  connect() {
    this.isClosedPurposely = false;

    let targetUrl = this.wsUrl;
    let endpointId = this.profileId;

    if (this.db) {
      const profile = this.db.getProfile(this.profileId);
      if (profile) {
        endpointId = profile.endpoint_id;
        if (!targetUrl && profile.relay_url) {
          const parsed = new URL(profile.relay_url);
          parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
          targetUrl = parsed.toString();
        }
      }
    }

    if (!targetUrl) {
      throw new Error(`WebSocket URL not configured for profile: ${this.profileId}`);
    }

    const wsUrlObj = new URL(targetUrl);
    wsUrlObj.searchParams.set('endpoint_id', endpointId);

    const headers = {
      Authorization: `Bearer ${this.authToken}`,
      'X-Sigil-Endpoint-Id': endpointId,
    };

    this.ws = new WebSocket(wsUrlObj.toString(), { headers });

    this.ws.on('open', this._onOpen);
    this.ws.on('message', this._onMessage);
    this.ws.on('pong', () => this.emit('heartbeat'));
    this.ws.on('close', this._onClose);
    this.ws.on('error', this._onError);
  }

  /**
   * Gracefully shuts down the connection and stops heartbeat timers.
   */
  disconnect() {
    this.close();
  }

  /**
   * Closes connection and cleans up background loops.
   */
  close() {
    this.isClosedPurposely = true;
    this.isConnected = false;
    this._stopHeartbeat();

    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Client shutting down');
      this.ws = null;
    }
  }

  /**
   * Handles stream connection opening. Resets reconnection counters and starts heartbeats.
   */
  _onOpen() {
    this.isConnected = true;
    this.reconnectAttempts = 0;
    this.missedPongs = 0;
    this.emit('connected');

    this._startHeartbeat();
    this.flushOutbox();
  }

  /**
   * Starts the application-level ping cycle.
   */
  _startHeartbeat() {
    this._stopHeartbeat();

    this.pingTimer = setInterval(() => {
      this._sendPing();
    }, this.pingIntervalMs);
  }

  /**
   * Stops the application-level ping cycle.
   */
  _stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Fires a JSON-formatted application-level ping frame.
   * Tracks outstanding pongs to enforce liveness limits.
   */
  _sendPing() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (this.missedPongs >= this.maxMissedPongs) {
      this._stopHeartbeat();
      this.emit('liveness_timeout');
      this.ws.terminate();
      return;
    }

    const pingFrame = JSON.stringify({
      type: 'ping',
      timestamp: new Date().toISOString(),
    });

    try {
      this.ws.ping();
      this.ws.send(pingFrame);
      this.missedPongs++;
    } catch (error) {
      this.emit('error', error);
    }
  }

  /**
   * Routes incoming messages based on their structural payload type.
   * Supports application-level pongs and real-time delivery state updates.
   */
  _onMessage(raw) {
    try {
      const frame = JSON.parse(raw.toString());
      const eventType = frame.type || frame.action;

      switch (eventType) {
        case 'pong':
          this.missedPongs = 0;
          this.emit('heartbeat_acknowledged');
          break;

        case 'delivery.receipt':
        case 'receipt':
          this._handleDeliveryReceipt(frame.payload || frame);
          break;

        case 'delivery':
          this._handleIncomingDelivery(frame.payload || frame);
          break;

        default:
          this.emit('unhandled_frame', frame);
      }
    } catch (err) {
      this.emit('error', new Error(`Failed to parse stream payload: ${err.message}`));
    }
  }

  /**
   * Idempotently updates outbox states inside SQLite upon receiving real-time delivery.receipt events.
   */
  _handleDeliveryReceipt(receipt) {
    const messageId = receipt.message_id;
    const state = receipt.state;
    const at = receipt.at || new Date().toISOString();
    const failureCode = receipt.failure_code || null;

    if (this.db && messageId) {
      try {
        this.db.updateOutboxDeliveryState(messageId, {
          state,
          attemptIncrement: 0,
          lastAttemptAt: at,
          failureCode,
        });
      } catch (dbError) {
        this.emit('error', dbError);
      }
    }

    this.emit('receipt_processed', receipt);
  }

  /**
   * Processes incoming real-time deliveries dispatched from the relay.
   * Follows the strict "Durable-Before-Ack" protocol boundary.
   */
  _handleIncomingDelivery(delivery) {
    const envelope = delivery.envelope || delivery;
    const deliveryId = delivery.delivery_id;
    const reconciledAt = new Date().toISOString();

    if (!this.db || !envelope?.message_id) {
      this.emit('error', new Error('Refusing to acknowledge delivery without durable database persistence'));
      return;
    }

    try {
      // 1. Commit message to durable SQLite storage BEFORE sending acceptance receipt back to relay
      this.db.commitDurableInboxIntake(envelope, this.profileId, reconciledAt);

      // 2. Transmit protocol acknowledgement frame only after successful local persistence
      this.sendFrame({
        action: 'acknowledge',
        payload: {
          message_id: envelope.message_id,
          delivery_id: deliveryId,
          reconciled_at: reconciledAt,
        },
      });

      this.emit('message_received', envelope);
    } catch (err) {
      // Fail closed: Do NOT acknowledge the message. The relay will retry delivery later.
      this.emit('error', new Error(`Failed to commit incoming envelope to durable local storage: ${err.message}`));
    }
  }

  /**
   * Sweeps SQLite outbox and transmits queued envelopes over the active WebSocket.
   */
  flushOutbox() {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN || !this.db) {
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

  startOutboxSweepLoop() {
    this.outboxTimer = setInterval(() => {
      this.flushOutbox();
    }, this.outboxSweepIntervalMs);
  }

  /**
   * Tracks unexpected stream drops and triggers the exponential backoff recovery loop.
   */
  _onClose(code, reason) {
    this.isConnected = false;
    this._stopHeartbeat();
    this.emit('disconnected', { code, reason: reason ? reason.toString() : '' });

    if (!this.isClosedPurposely) {
      this._scheduleReconnect();
    }
  }

  /**
   * Handles errors on the transport socket.
   */
  _onError(error) {
    this.emit('error', error);
  }

  /**
   * Calculates backoff delay and attempts reconnection.
   */
  _scheduleReconnect() {
    this.reconnectAttempts++;
    const delay = Math.min(
      Math.pow(2, this.reconnectAttempts) * 1000,
      this.maxReconnectDelayMs
    ) + Math.random() * 1000;

    setTimeout(() => {
      if (!this.isClosedPurposely && !this.isConnected) {
        this.connect();
      }
    }, delay);
  }
}

// Export alias for backward compatibility
export const WebSocketConnectionManager = ConnectorWebSocketManager;
